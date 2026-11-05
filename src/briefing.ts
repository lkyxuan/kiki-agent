// Daily briefing: every morning Kiki posts one message in the main chat — what got done since yesterday, what didn't, what's waiting on you, and what's planned for today.
// It's just a scheduled task: a "every day 08:30" task card whose executor is Kiki itself (briefing),
// with the content computed straight from the task ledger — no model call, so it's fast and never makes things up. If the user cancels this card on the board it stops sending, and it won't be recreated on restart.
import { showTime } from "./schedule.js";
import type { Task, Tasks } from "./tasks.js";

export const BRIEFING = "briefing";

const DAY = 86_400_000;
const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX = 8;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const firstLine = (s = "", n = 60) => {
  const l = s.split("\n").map((x) => x.trim()).find(Boolean) ?? "";
  return l.length > n ? `${l.slice(0, n)}…` : l;
};

function section(title: string, items: string[]): string[] {
  if (!items.length) return [];
  const shown = items.slice(0, MAX);
  if (items.length > MAX) shown.push(`- ${items.length - MAX} more, see /tasks all for everything`);
  return [`**${title}** (${items.length})`, ...shown, ""];
}

/** Compute the briefing body. extra.approvals: how many cards are waiting on the user's approval. */
export function briefing(all: Task[], now = new Date(), extra: { approvals?: number; coders?: { done: string[]; waiting: string[] } } = {}): string {
  const list = all.filter((t) => t.executor !== BRIEFING);
  const since = now.getTime() - DAY;
  const recent = (t: Task) => !!t.finished && new Date(t.finished).getTime() >= since;

  const done = list.filter((t) => t.status === "done" && recent(t)).map((t) => `- ${t.title} · ${t.agent}`);
  const failed = list
    .filter((t) => (t.status === "failed" || t.status === "interrupted") && recent(t))
    .map((t) => `- ${t.title}: ${firstLine(t.result, 40) || "didn't finish"} → /retry ${t.id}`);
  const waiting = list.filter((t) => t.status === "blocked").map((t) => `- ${t.title}: ${firstLine(t.question)} (/answer ${t.id} your answer)`);
  if (extra.approvals) waiting.push(`- ${extra.approvals} more cards waiting on your approval (right column, "Waiting on you")`);
  if (extra.coders) waiting.push(...extra.coders.waiting); // Claude Code / Codex sessions you started in the terminal
  const running = list.filter((t) => t.status === "running" || t.status === "queued").map((t) => `- In progress: ${t.title} · ${t.agent}`);
  const today = list
    .filter((t) => t.status === "todo" && !t.hold && t.when && sameDay(new Date(t.when), now) && new Date(t.when) >= now)
    .sort((a, b) => a.when!.localeCompare(b.when!))
    .map((t) => `- ${showTime(t.when!, now).replace(/^Today /, "")} ${t.title} · ${t.agent}${t.repeat ? ` (${t.repeat})` : ""}`);
  const watching = list.filter((t) => t.watching && t.status !== "cancelled").map((t) => `- ${t.title}: ${firstLine(t.watching)}`);
  const held = list.filter((t) => t.status === "todo" && t.hold).length;

  const p = (n: number) => String(n).padStart(2, "0");
  const lines = [`☀️ Good morning, today is ${WEEK[now.getDay()]}, ${now.toLocaleString("en-US", { month: "long" })} ${now.getDate()}.`, ""];
  const body = [
    ...section("Waiting on you", waiting),
    ...section("Didn't get done", failed),
    ...section("Done since yesterday", [...done, ...(extra.coders?.done ?? [])]),
    ...section("To do today", [...running, ...today]),
    ...section("Still watching", watching),
  ];
  if (!body.length) lines.push("No new tasks since yesterday, and nothing scheduled for today.");
  else lines.push(...body);
  if (held) lines.push(`Also, ${held} item${held === 1 ? " is" : "s are"} saved in your to-dos, waiting for you to start (visible on the board).`);
  return lines.join("\n").trim() + `\n\n(Briefing at ${p(now.getHours())}:${p(now.getMinutes())}; if you don't want it anymore, cancel "Daily briefing" on the board.)`;
}

/** Create the "Daily briefing" scheduled task card on first launch; if one already exists (including a cancelled one), leave it alone. */
export function ensureBriefing(tasks: Tasks, opts: { agent: string; at?: string }): Task | undefined {
  if (tasks.list((t) => t.executor === BRIEFING && !t.parent).length) return undefined;
  return tasks.start({
    agent: opts.agent,
    title: "Daily briefing",
    prompt: "Every morning, summarize: what got done since yesterday, what didn't, what's waiting on you, and what's planned for today.",
    repeat: `every day ${opts.at || "08:30"}`,
    executor: BRIEFING,
  });
}
