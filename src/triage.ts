// Kiki reads the mail: every new message that arrives in the Mailroom is looked at in two steps, and nobody reads everything:
//   1. Which bot it goes to: first a programmatic pre-filter (entries in each bot's watchlist that list keywords or senders — a hit decides it right away),
//      and if nothing hits, a cheap model picks by looking only at each bot's one-line description (same as Kiki's layered routing);
//   2. That bot judges using only its own watchlist: whether to alert you right away, whether to hand it off to be handled,
//      and which item on the list it matches (new ones get recorded, resolved ones get crossed off, and messages tied to a task conversation are handed back to that conversation).
// One list per bot: agents/<bot>/watchlist.md, which you can also edit yourself. Entries with keywords are only shown to the model when a message hits them, so the list can grow as long as it likes without blowing up the context.
// The importance the sender marks is only a reference; rule hits (key-rules.md) have already been alerted on directly before this.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baoDir } from "./bao.js";
import type { InboxItem } from "./postroom.js";

export const WATCH_FILE = "watchlist.md";
const MAX_ITEMS = 40; // at most this many items are handed to the model (entries without keywords take the most recent ones)

const head = (bao: string) => `# ${bao}'s watchlist

${bao} keeps track of things you care about that aren't settled yet. When a related new message arrives, it matches it against the history: newly surfaced things worth watching get recorded, and resolved ones get crossed off and reported to you.
You can also add and cross off items yourself (change [ ] to [x]). At the end of an entry, write 〔keywords: a, b〕 or 〔from: xxx〕, and only messages that hit it will be matched against it — the list can be as long as you like.

`;

export interface WatchItem {
  line: number; // which line in the file
  text: string;
  keys: string[]; // keywords (including the "from" sender); empty = matched every time
  link?: string; // linked conversation (the task's session), written as [continue](kiki:bot/conversation): new messages are handed back there
  task?: string; // linked task card, written as 〔task: id〕: new messages are handed back to that task to continue
}

/** The ones not yet settled (lines starting with - [ ]). */
export function openItems(md: string): WatchItem[] {
  const out: WatchItem[] = [];
  md.split("\n").forEach((l, line) => {
    const m = l.match(/^\s*[-*]\s*\[ \]\s*(.+?)\s*$/);
    if (!m) return;
    const link = m[1].match(/\]\(kiki:([^)]+)\)/)?.[1];
    const task = m[1].match(/〔task[:：]([^〕]+)〕/)?.[1]?.trim();
    const keys = [...m[1].matchAll(/〔(?:keywords|from)[:：]([^〕]+)〕/g)].flatMap((k) => k[1].split(/[、,，\s]+/)).map((k) => k.trim()).filter(Boolean);
    const text = m[1]
      .replace(/\s*\[[^\]]*\]\(kiki:[^)]+\)/g, "")
      .replace(/\s*〔[^〕]*〕/g, "")
      .trim();
    out.push({ line, text, keys, link, task });
  });
  return out;
}

/** Is this item related to the message: ones with keywords must hit; ones without keywords all count (left to the model to judge). */
export const hits = (w: WatchItem, hay: string) => w.keys.some((k) => hay.toLowerCase().includes(k.toLowerCase()));

export interface Verdict {
  important: boolean; // whether to alert you right away
  why?: string; // one line: why you should look / what this is about
  route: boolean; // whether to hand it to the bot to handle
  add?: string; // a new entry for the watchlist
  keys?: string[]; // keywords for the new entry
  done?: number[]; // which entries on the watchlist to cross off (1-based)
  doneWhy?: string; // why it counts as resolved
  related?: number[]; // which entries are related but not yet settled (for linked conversations, the message is handed back to that conversation)
}

export const PICK_SYSTEM = `You sort the inbox on the user's behalf: below are several assistants (called "bots"), each with one line saying what they handle. Look at which bot's domain the new message belongs to and output only one line of JSON: {"bao":"bot name"}; if none are relevant, {"bao":null}. Nothing else.`;

export const TRIAGE_SYSTEM = `You are the user's assistant, looking at one new message in the inbox on the user's behalf. Output only one line of JSON, nothing else.
Fields:
- important: whether this should alert the user right away. Account anomalies/theft/login alerts, failed charges or payments, overdue bills, services down, deadlines, and progress on watchlist items that needs the user to act all count as true; ads, routine notifications, daily reports, and things that completed normally count as false. When unsure, lean toward false — don't disturb the user.
- why: one line (within 30 characters) telling the user what this says and why it's worth looking at.
- route: whether to hand it to you to handle or follow up (true only if it needs checking, action, or a reply; false if it's just an FYI).
- add: if something surfaces that the user should keep an eye on and that isn't settled yet, write it in one line (e.g. "Binance account anomaly, pending confirmation of theft"); omit if none. Don't add anything already on the list.
- keys: give the add entry 2 to 4 keywords (sender, product name, order number, etc.) so related messages can be recognized later.
- done: which watchlist items this message shows are now resolved — a number array; omit if none.
- doneWhy: the reason it's resolved, one line.
- related: which watchlist items this is related to (new progress, needs the user's next step, but not yet settled) — a number array; omit if none.
The sender's own "important" mark is only a reference.`;

export function triageInput(it: Pick<InboxItem, "from" | "title" | "text" | "attention">, watch: WatchItem[], now = new Date()): string {
  const list = watch.length ? watch.map((w, i) => `${i + 1}. ${w.text}`).join("\n") : "(empty)";
  return `Now: ${now.toLocaleString("en-US", { hour12: false })}
Watchlist (not yet settled):
${list}

${messageText(it)}`;
}

function messageText(it: Pick<InboxItem, "from" | "title" | "text" | "attention">) {
  const body = it.text.length > 1500 ? `${it.text.slice(0, 1500)}…` : it.text;
  return `New message
Source: ${it.from}${it.attention ? " (sender marked it as needing attention)" : ""}
Title: ${it.title ?? "(none)"}
Body:
${body}`;
}

function json(raw: string): any {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]);
  } catch {
    return undefined;
  }
}
const ints = (v: unknown) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n)) : undefined);
const s80 = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : undefined);

export function parseVerdict(raw: string): Verdict | undefined {
  const j = json(raw);
  if (!j) return undefined;
  return {
    important: j.important === true,
    why: s80(j.why),
    route: j.route === true,
    add: s80(j.add),
    keys: Array.isArray(j.keys) ? j.keys.filter((k: unknown) => typeof k === "string" && k.trim()).slice(0, 4) : undefined,
    done: ints(j.done),
    doneWhy: s80(j.doneWhy),
    related: ints(j.related),
  };
}

/** A bot's watchlist: read it, add an entry, cross off a few. */
export class Watchlist {
  readonly file: string;
  constructor(
    dataDir: string,
    readonly bao: string,
  ) {
    this.file = join(baoDir(dataDir, bao), WATCH_FILE);
  }
  read(): string {
    return existsSync(this.file) ? readFileSync(this.file, "utf8") : head(this.bao);
  }
  open(): WatchItem[] {
    return openItems(this.read());
  }

  /** Record something to watch. keys are keywords or senders used to recognize related messages; when session is "bot/conversation", new messages will be handed back to that conversation later (useful for follow-ups after a task is done). */
  add(text: string, opts: { from?: string; keys?: string[]; session?: string; task?: string } = {}, now = new Date()) {
    const t = text.replace(/\s*\n\s*/g, " ").trim();
    if (!t || this.open().some((w) => w.text.startsWith(t))) return;
    const lines = this.read().split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const day = `${now.getMonth() + 1}/${now.getDate()}`;
    const keys = opts.keys?.length ? `〔keywords: ${opts.keys.join(", ")}〕` : "";
    const task = opts.task ? `〔task: ${opts.task}〕` : "";
    lines.push(`- [ ] ${t} (since ${day}${opts.from ? ` · ${opts.from}` : ""})${keys}${task}${opts.session ? ` [continue](kiki:${opts.session})` : ""}`, "");
    this.write(lines);
  }

  /** Cross off entries linked to this task (the task was cancelled, or there's no need to watch it anymore). Returns how many were crossed off. */
  removeByTask(taskId: string, why = "no need to watch anymore", now = new Date()): number {
    const items = this.open().filter((w) => w.task === taskId);
    if (!items.length) return 0;
    const lines = this.read().split("\n");
    for (const w of items) lines[w.line] = lines[w.line].replace("[ ]", "[x]") + ` (${now.getMonth() + 1}/${now.getDate()} ${why})`;
    this.write(lines);
    return items.length;
  }

  private write(lines: string[]) {
    writeFileSync(`${this.file}.tmp`, lines.join("\n"));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** Update the list according to the verdict (numbers refer to shown, i.e. the entries handed to the model), returning the original text of the ones crossed off. */
  apply(v: Verdict, from: string, shown: WatchItem[], now = new Date()): string[] {
    const crossed: string[] = [];
    if (v.done?.length) {
      const day = `${now.getMonth() + 1}/${now.getDate()}`;
      const lines = this.read().split("\n");
      for (const n of v.done) {
        const w = shown[n - 1];
        if (!w || !/\[ \]/.test(lines[w.line] ?? "")) continue;
        lines[w.line] = lines[w.line].replace("[ ]", "[x]") + ` (${day} resolved${v.doneWhy ? `: ${v.doneWhy}` : ""})`;
        crossed.push(w.text);
      }
      this.write(lines);
    }
    if (v.add) this.add(v.add, { from, keys: v.keys }, now);
    return crossed;
  }
}

export interface TriageResult extends Verdict {
  bao?: string; // which bot it was assigned to
  crossed: string[];
  follow: { text: string; link?: string; task?: string }[];
}

/** For the task board: when a task needs to wait for a follow-up, record it in its bot's watchlist. match is "how to recognize related messages"; short words are used as keywords. */
export function watchForTask(dataDir: string, w: { taskId: string; agent: string; about: string; match?: string; session?: string }) {
  const parts = (w.match ?? "").split(/[、,，;；\s]+/).map((k) => k.trim()).filter(Boolean);
  const keys = parts.length && parts.every((k) => k.length <= 20) ? parts.slice(0, 6) : [];
  const text = keys.length || !w.match ? w.about : `${w.about} (recognized by: ${w.match})`;
  new Watchlist(dataDir, w.agent).add(text, { from: "task", keys, session: w.session, task: w.taskId });
}

/** Task cancelled or no need to watch anymore: cross off entries linked to it in every bot's watchlist. */
export function unwatchTask(dataDir: string, baos: string[], taskId: string) {
  for (const b of baos) new Watchlist(dataDir, b).removeByTask(taskId);
}

/** The "read the mail" function used by the Mailroom. Returns undefined if the model errors, and the Mailroom hands it to Kiki the old way. */
export function makeTriage(opts: {
  dataDir: string;
  listBaos: () => string[];
  describe: (bao: string) => string;
  complete: (system: string, user: string) => Promise<string>;
}) {
  return async (it: InboxItem): Promise<TriageResult | undefined> => {
    const hay = `${it.from}\n${it.title ?? ""}\n${it.text}`;
    const baos = opts.listBaos();
    try {
      // 1. Which bot it goes to: sender-specified > most watchlist keyword hits > model looking at each bot's one-line description
      let bao = it.bao && baos.includes(it.bao) ? it.bao : undefined;
      if (!bao) {
        const score = baos.map((b) => ({ b, n: new Watchlist(opts.dataDir, b).open().filter((w) => hits(w, hay)).length })).sort((x, y) => y.n - x.n);
        if (score[0]?.n) bao = score[0].b;
      }
      if (!bao && baos.length) {
        const list = baos.map((b) => `- ${b}: ${opts.describe(b) || "(not written)"}`).join("\n");
        const j = json(await opts.complete(PICK_SYSTEM, `Bots:\n${list}\n\n${messageText(it)}`));
        if (typeof j?.bao === "string" && baos.includes(j.bao)) bao = j.bao;
      }
      // 2. That bot judges using only the relevant entries in its own list
      const wl = bao ? new Watchlist(opts.dataDir, bao) : undefined;
      const all = wl?.open() ?? [];
      const shown = [...all.filter((w) => hits(w, hay)), ...all.filter((w) => !w.keys.length).slice(-MAX_ITEMS)].slice(0, MAX_ITEMS);
      const v = parseVerdict(await opts.complete(TRIAGE_SYSTEM, triageInput(it, shown)));
      if (!v) return undefined;
      const crossed = wl ? wl.apply(v, it.from, shown) : [];
      const follow = (v.related ?? [])
        .map((n) => shown[n - 1])
        .filter((w) => !!w && (!!w.link || !!w.task))
        .map((w) => ({ text: w.text, link: w.link, task: w.task }));
      return { ...v, bao, crossed, follow };
    } catch (e) {
      console.warn(`[triage] failed to read the mail, handing it to Kiki as usual: ${(e as Error).message}`);
      return undefined;
    }
  };
}
