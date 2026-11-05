// Conversation summary: one sentence per conversation (30 to 40 characters), making clear what it's about and how far it's gotten.
// After each reply, a cheap model rewrites it in the background and stores it in registry.json. Kiki routing and the bot's main chat view of threads only look at summaries, never the raw text.
import type { Registry } from "./registry.js";

export const SUMMARY_MAX = 40;

const SYSTEM = `You write a one-sentence summary of a conversation for a routing assistant, so it can tell at a glance what the conversation is about and how far it's gotten.
Requirements: English, no more than ${SUMMARY_MAX} characters, one sentence, no quotation marks, no opening like "This conversation", output only the summary itself.
If there's an old summary, rewrite it based on the latest content.`;

export function buildSummaryInput(name: string, old: string | undefined, lines: { role: string; text: string }[]): string {
  const body = lines
    .slice(-12)
    .map((l) => `${l.role === "user" ? "User" : "Assistant"}: ${l.text.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return `Conversation name: ${name}\nOld summary: ${old ?? "(none)"}\n\nRecent content:\n${body}`;
}

/** Tidy the model output into one line, strip quotes and extra prefixes, truncate to the limit. */
export function cleanSummary(raw: string): string {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return [...line.replace(/^(Summary[:：]\s*)/, "").replace(/^["“「『]+|["”」』]+$/g, "").trim()].slice(0, SUMMARY_MAX).join("");
}

export class Summaries {
  private timers = new Map<string, NodeJS.Timeout>();
  private running = new Set<string>();
  private again = new Set<string>();

  constructor(
    private o: {
      registry: Registry;
      history: (path: string) => { role: string; text: string }[];
      complete: (system: string, user: string) => Promise<string>;
      delayMs?: number; // wait a bit after a reply before summarizing, so several messages in a row only summarize once
      after?: (path: string) => void; // what to do after the summary is written (work categorization needs the new summary)
    },
  ) {}

  /** This conversation just finished replying: update the summary in the background after a moment. */
  schedule(path: string) {
    if (!this.o.registry.byPath(path)) return;
    clearTimeout(this.timers.get(path));
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.run(path);
      }, this.o.delayMs ?? 1500),
    );
  }

  async run(path: string): Promise<void> {
    if (this.running.has(path)) {
      this.again.add(path); // already writing, run again once done
      return;
    }
    this.running.add(path);
    try {
      const rec = this.o.registry.byPath(path);
      if (!rec) return;
      const lines = this.o.history(path);
      let summary: string | undefined;
      if (lines.length) {
        try {
          summary = cleanSummary(await this.o.complete(SYSTEM, buildSummaryInput(rec.name, rec.summary, lines))) || undefined;
        } catch (e) {
          console.warn("[summary] Failed to write summary:", (e as Error).message);
        }
      }
      this.o.registry.setSummary(path, summary); // record activity time even if it can't be written
    } finally {
      this.running.delete(path);
      if (this.again.delete(path)) void this.run(path);
      else this.o.after?.(path);
    }
  }
}
