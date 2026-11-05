// Background task subprocess (the main process side).
//
// Each background task gets its own Node subprocess to run its pi conversation (comparable to the workers on the Hermes board, or sessions in the Claude Code desktop app):
// if one task hangs, blows up its memory, or crashes, it doesn't take down the main process or other conversations; stopping a task just shuts down that subprocess.
// Conversations (Kiki, a bot's main chat, threads) still live in the main process.
//
// The subprocess only runs the conversation; anything that needs the main process is asked back over IPC:
//   - Kiki's own tools (kiki_task, kiki_ask_user, handoff, ...) execute in the main process; the subprocess only has proxies with the same names;
//   - approval cards live in the main process (the fourth column, "waiting on you");
//   - progress, streaming text, and busy/idle are forwarded to the main process's Agents, and the web page keeps refreshing in real time as usual.
// See the top of worker.ts for the protocol.
import { type ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Live } from "./activity.js";

/** What a tool looks like in the subprocess: description only, execution goes back to the main process. */
export interface ToolMeta {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/** Which conversation the subprocess opens: an existing one, a new one, or a fork of another conversation. */
export type OpenSpec = { path: string } | { create: string } | { fork: { from: string; name: string } };

export interface WorkerHooks {
  tools(agent: string): ToolMeta[];
  /** Execute a Kiki tool in the main process, returning a pi tool result */
  runTool(agent: string, name: string, params: unknown, path: string, cwd: string, toolCallId: string): Promise<unknown>;
  /** Approval: return a reason to block it */
  approve(req: { toolName: string; input: unknown; cwd: string; path: string; turn?: import("./outside.js").TurnInfo }, signal: AbortSignal): Promise<{ block: true; reason: string } | undefined>;
}

export interface WorkerInit {
  dataDir: string;
  model: string;
  agent: string;
  open: OpenSpec;
}

/**
 * One subprocess = one conversation. Events: event(name, data) forwards the subprocess's Agents delta/busy/activity/message; exit.
 */
export class Worker extends EventEmitter {
  path?: string;
  busy = false;
  live?: Live;
  readonly ready: Promise<string>;
  private child: ChildProcess;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private asks = new Map<number, AbortController>(); // approvals the subprocess is waiting on
  private seq = 0;
  private exited = false;
  private killed = false;
  private exitWait: Promise<void>;

  constructor(script: string, init: WorkerInit, private hooks: WorkerHooks, execArgv: string[] = process.execArgv) {
    super();
    this.child = fork(script, [], {
      execArgv,
      env: process.env,
      serialization: "advanced",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let onReady!: (p: string) => void, onFail!: (e: Error) => void;
    this.ready = new Promise<string>((res, rej) => ((onReady = res), (onFail = rej)));
    this.ready.catch(() => {}); // don't report unhandled if nobody awaits it
    this.exitWait = new Promise((res) => this.child.once("exit", () => res()));
    this.child.on("message", (m: any) => this.onMessage(m, onReady, onFail));
    this.child.once("error", (e) => console.warn(`[worker] subprocess error: ${e.message}`));
    this.child.once("exit", (code, signal) => {
      this.exited = true;
      const err = new Error(this.killed ? "Stopped (background process was shut down)" : `Background process exited unexpectedly (${signal ?? `exit code ${code}`})`);
      onFail(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const c of this.asks.values()) c.abort();
      this.asks.clear();
      if (this.path && (this.busy || this.live)) {
        this.busy = false;
        this.live = undefined;
        this.emit("event", "activity", { path: this.path, live: null });
        this.emit("event", "busy", { path: this.path, busy: false });
      }
      this.emit("exit");
    });
    this.post({ t: "init", ...init, tools: hooks.tools(init.agent) });
  }

  get pid() {
    return this.child.pid;
  }

  get alive() {
    return !this.exited;
  }

  private post(m: object) {
    if (this.exited || !this.child.connected) return;
    this.child.send(m, (e) => e && console.warn(`[worker] failed to send to subprocess: ${e.message}`));
  }

  private call<T>(t: string, payload: object): Promise<T> {
    if (this.exited) return Promise.reject(new Error("The background process is already closed"));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ t, id, ...payload });
    });
  }

  private onMessage(m: any, onReady: (p: string) => void, onFail: (e: Error) => void) {
    switch (m?.t) {
      case "ready":
        this.path = m.path;
        onReady(m.path);
        break;
      case "init-fail":
        onFail(new Error(m.message));
        break;
      case "event":
        if (m.name === "busy") this.busy = !!m.data?.busy;
        if (m.name === "activity") this.live = m.data?.live ?? undefined;
        this.emit("event", m.name, m.data);
        break;
      case "reply":
      case "fail": {
        const p = this.pending.get(m.id);
        if (!p) break;
        this.pending.delete(m.id);
        if (m.t === "reply") p.resolve(m.text);
        else p.reject(new Error(m.message));
        break;
      }
      case "tool":
        this.hooks
          .runTool(m.agent, m.name, m.params, this.path ?? "", m.cwd ?? "", m.toolCallId)
          .catch((e) => ({ content: [{ type: "text", text: `Something went wrong: ${(e as Error).message}` }], details: undefined, isError: true }))
          .then((result) => this.post({ t: "tool-result", id: m.id, result }));
        break;
      case "approve": {
        const c = new AbortController();
        this.asks.set(m.id, c);
        this.hooks
          .approve({ toolName: m.toolName, input: m.input, cwd: m.cwd, path: this.path ?? "", turn: m.turn }, c.signal)
          .catch(() => ({ block: true as const, reason: "The approval failed, so let's skip this step for now." }))
          .then((r) => {
            this.asks.delete(m.id);
            this.post({ t: "approve-result", id: m.id, ...(r ?? {}) });
          });
        break;
      }
      case "approve-cancel":
        this.asks.get(m.id)?.abort();
        break;
    }
  }

  /** Send a message, wait for this turn to finish, and return the text of the last reply. */
  send(text: string): Promise<string> {
    return this.call("send", { text });
  }

  /** Steer a message into the turn that's currently running (if nothing is running, it's just a normal message). */
  steer(text: string): Promise<void> {
    return this.call("steer", { text });
  }

  /** Record a message at the end of the conversation without triggering a reply. */
  note(text: string): Promise<void> {
    return this.call("note", { text });
  }

  /** Done: let the subprocess wrap up and exit on its own; force it closed if it hasn't exited in 5 seconds. */
  async close(): Promise<void> {
    if (this.exited) return;
    this.post({ t: "exit" });
    const t = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    t.unref();
    await this.exitWait;
    clearTimeout(t);
  }

  /** Stop the task: shut down the subprocess (SIGTERM first, SIGKILL if it hasn't exited in 3 seconds). */
  async kill(): Promise<void> {
    if (this.exited) return;
    this.killed = true;
    this.child.kill("SIGTERM");
    const t = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    t.unref();
    await this.exitWait;
    clearTimeout(t);
  }
}
