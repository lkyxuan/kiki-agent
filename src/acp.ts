// The Mailroom's ACP adapter: connects to local coding agents like Claude Code and Codex.
// ACP (Agent Client Protocol) is JSON-RPC over stdin/stdout: Kiki plays the "editor" side,
// starts an agent process, initialize → open a new session for each job session/new → session/prompt,
// collects text from session/update as it works, and hands the whole answer back to the Mailroom as a reply.
// When the other side asks for permission (session/request_permission), decide by Kiki's approval rules: deletes, force pushes, outbound sends, and spending go through the fallback (back up first, ready to send, budget); everything else is approved directly.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { classify } from "./approval.js";
import { findBin } from "./mcp.js";
import type { AdapterContext, AgentConfig, AgentStatus, ExternalAgent, Incoming, Outgoing } from "./postroom.js";
import { expand } from "./postroom.js";

/** Presets: look for an installed command first; if not found, pull the official ACP adapter package with npx. */
export const ACP_PRESETS: Record<string, { bins: string[]; npx: string }> = {
  "claude-code": { bins: ["claude-agent-acp", "claude-code-acp"], npx: "@agentclientprotocol/claude-agent-acp" },
  codex: { bins: ["codex-acp"], npx: "@agentclientprotocol/codex-acp" },
};

export function resolveCommand(cfg: AgentConfig): { command: string; args: string[] } {
  if (cfg.command) return { command: cfg.command.startsWith("~") ? expand(cfg.command) : cfg.command, args: (cfg.args ?? []).map(String) };
  const p = ACP_PRESETS[cfg.preset ?? ""];
  if (!p) throw new Error(`ACP needs a preset (${Object.keys(ACP_PRESETS).join(" or ")}) or a command`);
  for (const b of p.bins) {
    const hit = findBin(b);
    if (hit) return { command: hit, args: [] };
  }
  const npx = findBin("npx");
  if (!npx) throw new Error(`Couldn't find ${p.bins[0]} or npx. Install Node first (brew install node) or run npm i -g ${p.npx}`);
  return { command: npx, args: ["-y", p.npx] };
}

interface Job {
  title: string;
  origin?: string;
  chunks: string[];
}

/** One ACP agent process. The process starts on demand; if it dies, it starts again on the next dispatch. */
export class AcpAgent implements ExternalAgent {
  readonly kind = "acp";
  private proc?: ChildProcess;
  private ready?: Promise<void>;
  private seq = 0;
  private calls = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  private jobs = new Map<string, Job>(); // sessionId -> job in progress
  private sessions = new Map<string, string>(); // dispatch id -> sessionId
  private done: Incoming[] = [];
  private lastError?: string;
  private cwd: string;

  constructor(
    readonly name: string,
    private cfg: AgentConfig,
    private ctx: AdapterContext,
    private launch: (cmd: string, args: string[], cwd: string) => ChildProcess = defaultLaunch,
  ) {
    this.cwd = cfg.cwd ? expand(cfg.cwd) : join(ctx.root, "acp", name); // if unset, give it its own empty folder so it doesn't mess around in your home directory
    mkdirSync(this.cwd, { recursive: true });
  }

  async status(): Promise<AgentStatus> {
    if (this.jobs.size) return { state: "working", note: `${this.jobs.size} in progress` };
    if (this.lastError) return { state: "error", note: this.lastError };
    return { state: "idle", note: this.proc ? undefined : "starts on dispatch" };
  }

  async dispatch(t: Outgoing) {
    await this.start();
    const { sessionId } = await this.call("session/new", { cwd: this.cwd, mcpServers: [] });
    this.jobs.set(sessionId, { title: t.title, origin: t.origin, chunks: [] });
    this.sessions.set(t.id, sessionId);
    // Don't wait for it to finish: long jobs can take tens of minutes; hand it back in collect when done
    this.call("session/prompt", { sessionId, prompt: [{ type: "text", text: t.from ? `(from Kiki · ${t.from})\n${t.text}` : t.text }] })
      .then((r) => this.finish(sessionId, t.id, r?.stopReason))
      .catch((e) => this.finish(sessionId, t.id, "error", (e as Error).message));
  }

  private finish(sessionId: string, id: string, stop?: string, err?: string) {
    const job = this.jobs.get(sessionId);
    this.jobs.delete(sessionId);
    this.sessions.delete(id);
    const text = job?.chunks.join("").trim() ?? "";
    const why = err ? `(error: ${err})\n` : stop && stop !== "end_turn" ? `(stopped because: ${stop})\n` : "";
    this.done.push({ id: `${id}-r`, re: id, title: job?.title, text: why + (text || "(no text answer)"), attention: !!err || undefined });
    this.ctx.wake(); // hand it back right away, don't wait for the next round
  }

  async cancel(id: string) {
    const sessionId = this.sessions.get(id);
    if (sessionId) this.send({ method: "session/cancel", params: { sessionId } }); // notification, no need to wait for a reply
  }

  async collect(): Promise<Incoming[]> {
    const out = this.done;
    this.done = [];
    return out;
  }

  close() {
    this.proc?.kill();
    this.proc = undefined;
    this.ready = undefined;
  }

  // ---------- JSON-RPC ----------

  private start(): Promise<void> {
    if (this.ready && this.proc && this.proc.exitCode === null) return this.ready;
    const { command, args } = resolveCommand(this.cfg);
    const proc = this.launch(command, args, this.cwd);
    this.proc = proc;
    let buf = "";
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    let errTail = "";
    proc.stderr?.on("data", (d) => (errTail = (errTail + String(d)).slice(-500)));
    const gone = (why: string) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.ready = undefined;
      this.lastError = why;
      for (const c of this.calls.values()) c.fail(new Error(why));
      this.calls.clear();
    };
    proc.on("error", (e) => gone(`failed to start: ${e.message}`));
    proc.on("exit", (code) => gone(`process exited (${code})${errTail ? `: ${errTail.trim().split("\n").pop()}` : ""}`));
    this.ready = this.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, // let it use its own tools to read/write files and run commands
    }).then(() => {
      this.lastError = undefined;
    });
    return this.ready;
  }

  private send(msg: object) {
    this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  }

  private call(method: string, params: unknown): Promise<any> {
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      this.calls.set(id, { ok, fail });
      this.send({ id, method, params });
    });
  }

  private onLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return; // skip non-JSON output (logs)
    }
    if (m.method && m.id !== undefined) return void this.onRequest(m);
    if (m.method === "session/update") {
      const u = m.params?.update;
      const job = this.jobs.get(m.params?.sessionId);
      if (job && u?.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") job.chunks.push(u.content.text);
      return;
    }
    const c = m.id !== undefined ? this.calls.get(m.id) : undefined;
    if (!c) return;
    this.calls.delete(m.id);
    if (m.error) c.fail(new Error(m.error.message ?? JSON.stringify(m.error)));
    else c.ok(m.result);
  }

  /** Requests from the other side: only permission requests are recognized; others (file read/write, terminal) aren't exposed, so reply "not supported". */
  private async onRequest(m: any) {
    if (m.method !== "session/request_permission") return this.send({ id: m.id, error: { code: -32601, message: "Kiki doesn't expose this capability" } });
    const p = m.params ?? {};
    const options: any[] = Array.isArray(p.options) ? p.options : [];
    const pick = (kinds: string[]) => options.find((o) => kinds.includes(o.kind))?.optionId;
    let ok = true;
    try {
      ok = await this.allowed(p);
    } catch {
      ok = false;
    }
    const optionId = ok ? pick(["allow_once", "allow_always"]) : pick(["reject_once", "reject_always"]);
    this.send({ id: m.id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
  }

  /** Same rules as Kiki's own conversations: commands go through cc-safety-net, dangerous ones go through the fallback (back up first, ready to send, budget), everything else is done directly. */
  private async allowed(p: any): Promise<boolean> {
    const tc = p.toolCall ?? {};
    const raw = tc.rawInput ?? {};
    const command = typeof raw.command === "string" ? raw.command : Array.isArray(raw.command) ? raw.command.join(" ") : undefined;
    const job = this.jobs.get(p.sessionId);
    const dataDir = dirname(this.ctx.root);
    const hit = command
      ? await classify(dataDir, "bash", { command }, this.cwd)
      : tc.kind === "delete"
        ? { category: "delete" as const, key: `acp:${this.name}:delete`, label: `Permanent delete: ${this.name} deletes files` }
        : undefined;
    if (!hit) return true;
    return this.ctx.approve({
      agent: this.name,
      origin: job?.origin,
      ...hit,
      ...(command ? { command, cwd: this.cwd } : {}),
      detail: `${this.name}: ${String(tc.title ?? "")}\n${command ?? JSON.stringify(raw, null, 2)}`.slice(0, 2000),
    });
  }
}

function defaultLaunch(command: string, args: string[], cwd: string): ChildProcess {
  return spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin")].join(delimiter) },
  });
}
