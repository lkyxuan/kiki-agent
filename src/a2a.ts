// The Mailroom's A2A adapter: connects to agents that speak the A2A protocol (such as our own Grokbot).
// A2A is JSON-RPC over HTTP: first read the other party's card (/.well-known/agent-card.json), dispatch work with message/send,
// and check progress with tasks/get. When the other party finishes (or gets stuck and needs a human), the Mailroom receives a message with re, returning to the conversation where the work was dispatched.
// Tasks still waiting are recorded in postroom/state/<name>.json, and Kiki keeps checking after a restart.
import type { AdapterContext, AgentConfig, AgentStatus, ExternalAgent, Incoming, Outgoing } from "./postroom.js";
import { loadState, saveState } from "./postroom.js";

/** States that are done and will not change again */
const FINAL = new Set(["completed", "failed", "canceled", "rejected"]);
/** States that are stuck and need a human reply: report to you and stop following up */
const NEEDS_YOU = new Set(["input-required", "auth-required"]);
const STATE_WORD: Record<string, string> = { failed: "failed", canceled: "canceled", rejected: "rejected", "input-required": "needs your reply", "auth-required": "needs login authorization" };

interface Pending {
  task?: string; // the other party's task id
  context?: string;
  title: string;
}

type Fetch = typeof fetch;

export class A2AAgent implements ExternalAgent {
  readonly kind = "a2a";
  private endpoint?: string;
  private pending: Record<string, Pending>; // our dispatch id -> the other party's task
  private done: Incoming[] = []; // message/send answered directly; handed over on the next collect

  constructor(
    readonly name: string,
    private cfg: AgentConfig,
    private ctx: AdapterContext,
    private http: Fetch = fetch,
  ) {
    if (!cfg.url) throw new Error("A2A requires url (the other party's address)");
    this.pending = loadState(ctx.root, name, { pending: {} as Record<string, Pending> }).pending;
  }

  private save() {
    saveState(this.ctx.root, this.name, { pending: this.pending });
  }

  /** Read the card to get the JSON-RPC address; if the card doesn't specify one, use the configured url. */
  private async card(): Promise<{ name?: string; url?: string }> {
    const base = this.cfg.url!.replace(/\/+$/, "");
    for (const p of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const r = await this.http(base + p, { headers: this.headers(), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      if (r?.ok) return (await r.json()) as any;
    }
    throw new Error("Could not read the other party's card (agent-card.json)");
  }

  private headers(): Record<string, string> {
    return { accept: "application/json", ...(this.cfg.headers ?? {}) };
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    this.endpoint ??= (await this.card()).url || this.cfg.url!;
    const r = await this.http(this.endpoint, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`A2A ${method}: HTTP ${r.status}`);
    const j: any = await r.json();
    if (j.error) throw new Error(`A2A ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  }

  async status(): Promise<AgentStatus> {
    try {
      await this.card();
    } catch (e) {
      return { state: "offline", note: (e as Error).message };
    }
    const n = Object.keys(this.pending).length;
    return n ? { state: "working", note: `${n} in progress` } : { state: "idle" };
  }

  async dispatch(t: Outgoing) {
    const result = await this.rpc("message/send", {
      message: {
        kind: "message",
        role: "user",
        messageId: t.id,
        parts: [{ kind: "text", text: t.from ? `(from Kiki · ${t.from})\n${t.text}` : t.text }],
        metadata: { kikiId: t.id, title: t.title },
      },
      configuration: {
        blocking: false,
        acceptedOutputModes: ["text/plain", "text/markdown"],
        // If pushUrl is set (Kiki's address, reachable by the other party), ask the other party to push when done so we receive it immediately; otherwise rely on polling every minute
        ...(this.cfg.pushUrl ? { pushNotificationConfig: { url: `${String(this.cfg.pushUrl).replace(/\/+$/, "")}/api/postroom/push/${encodeURIComponent(this.name)}` } } : {}),
      },
    });
    this.pending[t.id] = { title: t.title };
    this.take(t.id, result);
    this.save();
    if (this.done.length) this.ctx.wake(); // the other party answered on the spot
  }

  /** The other party's result: if it's a message, treat it as the answer; if it's a task, check the state and treat it as a reply once done or stuck. */
  private take(id: string, result: any) {
    const p = this.pending[id];
    if (!p || !result) return;
    if (result.kind === "message" || (!result.status && result.parts)) {
      this.finish(id, textOf(result.parts));
      return;
    }
    p.task = result.id ?? p.task;
    p.context = result.contextId ?? p.context;
    const state: string = result.status?.state ?? "";
    if (FINAL.has(state) || NEEDS_YOU.has(state)) {
      const body = [textOf(result.artifacts?.flatMap((a: any) => a.parts ?? [])), textOf(result.status?.message?.parts)].filter(Boolean).join("\n\n");
      const head = STATE_WORD[state] ? `(the other party ${STATE_WORD[state]})\n` : "";
      this.finish(id, head + (body || "(no text result)"), NEEDS_YOU.has(state));
    }
  }

  private finish(id: string, text: string, attention = false) {
    const p = this.pending[id];
    delete this.pending[id];
    this.done.push({ id: `${id}-r`, re: id, title: p?.title, text, attention: attention || undefined });
  }

  /** Task state pushed by the other party */
  onPush(payload: any) {
    const task = payload?.result ?? payload?.task ?? payload;
    const id = Object.entries(this.pending).find(([, p]) => p.task && p.task === task?.id)?.[0];
    if (!id) return;
    this.take(id, task);
    this.save();
    if (this.done.length) this.ctx.wake();
  }

  async cancel(id: string) {
    const p = this.pending[id];
    delete this.pending[id];
    this.save();
    if (p?.task) await this.rpc("tasks/cancel", { id: p.task });
  }

  async collect(): Promise<Incoming[]> {
    for (const [id, p] of Object.entries(this.pending)) {
      if (!p.task) continue;
      try {
        this.take(id, await this.rpc("tasks/get", { id: p.task }));
      } catch (e) {
        console.warn(`[a2a] ${this.name} failed to check task ${p.task}: ${(e as Error).message}`);
      }
    }
    this.save();
    const out = this.done;
    this.done = [];
    return out;
  }
}

function textOf(parts: any): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p?.text === "string" ? p.text : p?.data !== undefined ? "```json\n" + JSON.stringify(p.data, null, 2) + "\n```" : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}
