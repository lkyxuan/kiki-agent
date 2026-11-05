// Background task child process (the child side): opens a pi conversation and runs it on the parent's instructions.
//
// Parent → child:
//   init {dataDir, model, agent, open, tools}   open a conversation: open is {path} / {create: name} / {fork: {from, name}}
//   send {id, text} · steer {id, text} · note {id, text}
//   tool-result {id, result} · approve-result {id, block?, reason?}
//   exit                                          done, wrap up and exit
// Child → parent:
//   ready {path} · init-fail {message}
//   event {name, data}                            Agents' delta / busy / activity / message
//   reply {id, text} · fail {id, message}
//   tool {id, agent, name, params, toolCallId, cwd}   Kiki's tools execute in the parent
//   approve {id, toolName, input, cwd, turn} · approve-cancel {id}
// When stopping a task the parent closes the child directly; if the parent is gone (IPC disconnected) the child exits too.
import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { turnInfo } from "./outside.js";
import type { OpenSpec, ToolMeta } from "./workerhost.js";

/** The bits of Agents the child uses (swapped for fakes in tests). */
export interface ChildAgents {
  toolsFor?: (agent: string) => ToolDefinition[];
  extensions: ExtensionFactory[];
  on(event: string, fn: (data: any) => void): unknown;
  create(agent: string, name: string): Promise<string>;
  fork(agent: string, from: string, name: string): Promise<string>;
  send(agent: string, path: string, text: string): Promise<string>;
  steer(agent: string, path: string, text: string): Promise<void>;
  note(agent: string, path: string, text: string): Promise<void>;
}

export interface Port {
  send?(m: unknown): unknown;
  on(event: "message" | "disconnect", fn: (m?: any) => void): unknown;
}

export function serve(port: Port, makeAgents: (dataDir: string, model: string) => ChildAgents, exit: (code: number) => void = process.exit) {
  const out = (m: object) => port.send?.(m);
  let agents: ChildAgents | undefined;
  let agent = "";
  let path = "";
  let seq = 0;
  const waiting = new Map<number, (m: any) => void>();
  const ask = (m: object) =>
    new Promise<any>((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      out({ ...m, id });
    });

  const proxy = (meta: ToolMeta): ToolDefinition =>
    ({
      ...meta,
      async execute(toolCallId: string, params: unknown, _signal: unknown, _onUpdate: unknown, ctx: any) {
        const r = await ask({ t: "tool", agent, name: meta.name, params, toolCallId, cwd: ctx?.cwd });
        return r.result;
      },
    }) as unknown as ToolDefinition;

  const approval: ExtensionFactory = (pi) => {
    pi.on("tool_call", async (ev, ctx) => {
      let id = 0;
      const cancel = () => out({ t: "approve-cancel", id });
      const p = new Promise<any>((resolve) => {
        id = ++seq;
        waiting.set(id, resolve);
        out({ t: "approve", id, toolName: ev.toolName, input: ev.input, cwd: ctx.cwd, turn: turnInfo(ctx.sessionManager) });
      });
      ctx.signal?.addEventListener("abort", cancel, { once: true });
      const r = await p;
      ctx.signal?.removeEventListener("abort", cancel);
      return r.block ? { block: true, reason: r.reason } : undefined;
    });
  };

  const answer = (id: number, work: Promise<unknown>) =>
    work.then(
      (text) => out({ t: "reply", id, text }),
      (e) => out({ t: "fail", id, message: (e as Error)?.message ?? String(e) }),
    );

  port.on("disconnect", () => exit(0));
  port.on("message", async (m: any) => {
    switch (m?.t) {
      case "init": {
        try {
          agent = m.agent;
          agents = makeAgents(m.dataDir, m.model);
          const tools: ToolMeta[] = m.tools ?? [];
          agents.toolsFor = () => tools.map(proxy);
          agents.extensions.push(approval);
          for (const name of ["delta", "busy", "activity", "message"]) agents.on(name, (data) => out({ t: "event", name, data }));
          const open: OpenSpec = m.open;
          path =
            "path" in open
              ? open.path
              : "create" in open
                ? await agents.create(agent, open.create)
                : await agents.fork(agent, open.fork.from, open.fork.name);
          out({ t: "ready", path });
        } catch (e) {
          out({ t: "init-fail", message: (e as Error).message });
          exit(1);
        }
        break;
      }
      case "send":
        answer(m.id, agents ? agents.send(agent, path, m.text) : Promise.reject(new Error("conversation not open yet")));
        break;
      case "steer":
        answer(m.id, agents ? agents.steer(agent, path, m.text) : Promise.reject(new Error("conversation not open yet")));
        break;
      case "note":
        answer(m.id, agents ? agents.note(agent, path, m.text) : Promise.reject(new Error("conversation not open yet")));
        break;
      case "tool-result":
      case "approve-result": {
        const done = waiting.get(m.id);
        waiting.delete(m.id);
        done?.(m);
        break;
      }
      case "exit":
        exit(0);
        break;
    }
  });
}
