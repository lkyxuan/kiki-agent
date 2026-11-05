// "Quick ack": as soon as a message is sent, the app immediately puts an emoji on your bubble, without waiting for the model.
// 👀 seen (disappears once answered); 🕐 still working on something earlier, queued; ⏳ moved to the background; ✅ background work done; ✋ waiting on your answer; ❗ something went wrong.
// Kept in memory only, never written to the conversation log: gone after a restart, and showing it live by status is enough. Future channels like WeChat will use the same "received" signal.
import { EventEmitter } from "node:events";
import type { Task, TaskStatus } from "./tasks.js";

export type Mark = "seen" | "queued" | "bg" | "done" | "ask" | "error";

export interface Ack {
  id: string;
  path: string; // which conversation (Kiki is "main")
  text: string; // the exact words you sent; the web page uses it to find that bubble in the old log
  mark: Mark | null; // null: emoji removed, but the "quick ack" is still kept
  tasks?: Record<string, TaskStatus>; // the background tasks this message was moved into (several when split into pieces) and their statuses
  say?: string; // the one-liner the small model replied first (the model comes from "quick ack" in the per-purpose config)
}

const KEEP = 60; // max entries kept (✅ ❗ stay visible, so the oldest get dropped)

/**
 * The emoji for each message. Event: change {path, id, mark}; mark null means the emoji was removed.
 */
export class Acks extends EventEmitter {
  private all = new Map<string, Ack>();
  private seq = 0;

  /** A message came in: mark queued when busy, otherwise 👀. Returns this message's id. */
  add(path: string, text: string, busy = false): string {
    const id = `a${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    this.all.set(id, { id, path, text, mark: busy ? "queued" : "seen" });
    while (this.all.size > KEEP) this.all.delete(this.all.keys().next().value!);
    this.emit("change", { path, id, text, mark: busy ? "queued" : "seen" });
    return id;
  }

  /** Change the emoji; null removes it. */
  set(id: string, mark: Mark | null) {
    const a = this.all.get(id);
    if (!a) return;
    if (a.mark === mark) return;
    if (mark === null && !a.say) this.all.delete(id);
    else a.mark = mark;
    this.emit("change", { path: a.path, id, mark });
  }

  /** The one-liner the small model replied first: attached under this message. If the message is already answered (emoji gone), don't show it, to avoid being wise after the fact. */
  say(id: string, text: string) {
    const a = this.all.get(id);
    if (!a || !text || a.mark === null) return;
    a.say = text;
    this.emit("change", { path: a.path, id, mark: a.mark, say: text });
  }

  /** Processing started: queued → 👀. */
  start(id: string) {
    if (this.all.get(id)?.mark === "queued") this.set(id, "seen");
  }

  get(id: string) {
    return this.all.get(id);
  }

  /** The emojis currently attached (fetched once when the web page opens). */
  list(): Ack[] {
    return [...this.all.values()];
  }

  /** The background tasks this message was moved into: from now on the emoji follows these tasks' statuses. */
  link(id: string, tasks: Task[]) {
    const a = this.all.get(id);
    if (!a || !tasks.length) return;
    a.tasks = { ...a.tasks, ...Object.fromEntries(tasks.map((t) => [t.id, t.status])) };
    this.refresh(a);
  }

  /** Are these tasks already attached to some message (so two messages don't grab the same task). */
  linked(taskId: string) {
    return [...this.all.values()].some((a) => a.tasks && taskId in a.tasks);
  }

  /** A background task's status changed: switch the emoji to follow. */
  onTask(t: Task) {
    for (const a of this.all.values()) {
      if (!a.tasks || !(t.id in a.tasks)) continue;
      a.tasks[t.id] = t.status;
      this.refresh(a);
    }
  }

  /** Combine the statuses of all this message's tasks into one emoji: any error → ❗, any waiting on you → ✋, any still working → ⏳, only ✅ once all are done. */
  private refresh(a: Ack) {
    const marks = Object.values(a.tasks ?? {}).map((status) => taskMark({ status } as Task));
    const m = (["error", "ask", "bg", "done"] as const).find((x) => marks.includes(x));
    if (m) this.set(a.id, m);
    else if (marks.length && marks.every((x) => x === null)) this.set(a.id, null); // all cancelled
  }
}

/** Which emoji a background task's status maps to; null removes it, undefined means leave it alone. */
export function taskMark(t: Task): Mark | null | undefined {
  if (t.status === "done") return "done";
  if (t.status === "failed" || t.status === "interrupted") return "error";
  if (t.status === "blocked") return "ask";
  if (t.status === "cancelled") return null; // cancelled: don't show
  if (t.status === "queued" || t.status === "running" || t.status === "todo") return "bg";
  return undefined;
}

/**
 * Kiki replied with a line; which emoji this message should switch to. Looks at the receipt format the router itself writes (router.ts).
 * Returns null to remove the emoji (answered); undefined means leave it alone.
 */
export function markForReply(text: string): Mark | null | undefined {
  const head = text.split("\n", 1)[0];
  if (/^→ .+ · background task "/.test(head)) return "bg";
  if (head.startsWith("✅ background task")) return "done";
  if (head.startsWith("❌ background task")) return "error";
  if (head.startsWith("⏸ background task")) return "ask";
  if (head.startsWith("something went wrong:")) return "error";
  // split into pieces: if any went to the background, attach ⏳; otherwise each piece's answer is in its own conversation, and Kiki's side counts as received
  if (/^- background task "/m.test(text)) return "bg";
  return null;
}

/**
 * The rule for every conversation: when about to do real work, first say in one sentence what you understand needs doing, then start.
 * So the user sees at a glance that "it got it", rather than an empty "received".
 */
export const FIRST_LINE_RULE = `## Acknowledge the user first
When the user's request needs real work (using tools, more than a step or two), first say in one sentence what you understand needs doing and how you plan to do it, then start; this sentence must be specific, don't just say "received" or "okay".
For simple questions, small talk, or anything answerable in one sentence, answer directly without preamble.`;
