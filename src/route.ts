// Automatic conversation routing (layer one): the main bot receives a message and decides which existing conversation to attach it to, or under which bot to start a new one.
// It also gives the layer-two suggestion: chat, or work in the background.
// This file is pure logic only (assembling the prompt, parsing the result); model calls and execution live in router.ts.

import { MAIN_SESSION, validBaoName } from "./bao.js";

export interface RouteCandidate {
  agent: string;
  desc: string; // what this bot is responsible for
  /** The main chat, the current conversation, and the most recently active threads; one summary line per conversation, falling back to the user's most recent message when there is no summary */
  sessions: { label: string; summary?: string; recent: string[]; background?: boolean }[];
  more?: number; // how many older threads are not listed (handed to the main chat, which can see them all)
}

export type Mode = "chat" | "background";

export type Decision =
  | { action: "continue"; target: string; mode: Mode; taskTitle?: string; doneWhen?: string; reason?: string }
  /** newBao: the bot does not exist yet, create it first; the value is what this bot is responsible for */
  | { action: "new"; agent: string; name: string; mode: Mode; taskTitle?: string; doneWhen?: string; reason?: string; newBao?: string }
  /** The message is about an existing background task (changing it, adding to it, redoing it, or any request other than asking for progress): hand this message to that task */
  | { action: "task"; id: string; text: string; mode: "chat"; reason?: string }
  /** Something Kiki can answer in one line directly, without entering any conversation */
  | { action: "reply"; text: string; mode: "chat"; reason?: string }
  /** One message contains several unrelated things: split them up and hand each one off with its own instructions */
  | { action: "split"; parts: Part[]; mode: "chat"; reason?: string };

/** One split-out item: where it goes (attach to an existing conversation / start a new one) + the message handed over (with its own context) */
export type Part = (Extract<Decision, { action: "continue" }> | Extract<Decision, { action: "new" }>) & { text: string };

const MAX_PARTS = 6;


/** The routing system prompt = fixed opening + user-editable routing rules (~/Kiki/routing-rules.md) + fixed output format.
 *  The judgment criteria live in the rules file so the user can change them; the output format is parsed by the program, so it stays in the code. */
export function buildRouteSystem(rules: string): string {
  return `You are Kiki, the triage desk of the personal assistant Kiki. Every message from the user is either answered directly by you or handed off.
Conversations are grouped by "bot", and each bot is responsible for one domain. Each bot has a "${MAIN_SESSION}" conversation, which is that bot's coordinator; it opens specific work as threads itself. The other conversations under a bot are threads.
When handing off: if the message clearly belongs to an existing thread, hand it straight into that thread; otherwise hand it to the "${MAIN_SESSION}" of the closest bot; if no bot fits, create a new one.
Always make the decision yourself; never ask the user a question back.

Below are the routing rules set by the user:
${rules.trim()}

The "Background tasks" section below lists tasks that are in progress, queued, waiting for the user's answer, to-do, and just finished. If the user's message is clearly changing a task, adding requirements to it, or asking it to redo something, hand it to that task using the task format, with text written as one sentence addressed to that task.

Output only a single JSON object, with no other text. Five formats (when mode is background, add "taskTitle": a task name of 10 characters or fewer; also add "doneWhen": one sentence describing what counts as done):
Hand into a bot's main chat or a thread: {"action":"continue","target":"bot name/conversation name","mode":"chat","reason":"one-line reason"}
Create a new bot (hand to its main chat): {"action":"new","agent":"new bot name","newBao":"what this bot is responsible for, in one sentence","mode":"chat","reason":"one-line reason"}
Answer directly: {"action":"reply","text":"the answer to the user","reason":"one-line reason"}
Hand to a background task: {"action":"task","id":"task id","text":"the message for that task","reason":"one-line reason"}
Split into several items and hand each off separately (each item in parts uses the continue or new format above, plus "text": the message for that side, carrying its own context, since that side cannot see the user's original message):
{"action":"split","parts":[{"action":"continue","target":"bot name/${MAIN_SESSION}","mode":"chat","text":"…"},{"action":"new","agent":"new bot name","newBao":"…","mode":"chat","text":"…"}],"reason":"one-line reason"}`;
}

export function buildRouteInput(opts: {
  text: string;
  candidates: RouteCandidate[];
  current?: string;
  onlyAgent?: string; // the user @-mentioned a bot, so the choice must be under it
  now?: string; // the current time and time zone, used to answer "what time is it" or "what's today's date" directly
  tasks?: { id: string; title: string; status: string; agent: string }[]; // overview of background tasks (unfinished + just finished)
}): string {
  const lines: string[] = [];
  if (opts.now) lines.push(`Now: ${opts.now}\n`);
  for (const c of opts.candidates) {
    if (opts.onlyAgent && c.agent !== opts.onlyAgent) continue;
    lines.push(`## Bot: ${c.agent}${c.desc ? ` (${c.desc})` : ""}`);
    if (c.sessions.length === 0) lines.push("(no conversations yet)");
    for (const s of c.sessions) {
      const tag = [s.label === opts.current ? "[current]" : "", s.background ? "[background task]" : ""].join("");
      const about = s.summary ? `: ${s.summary}` : s.recent.length ? `: recently said ${s.recent.map((r) => `"${r}"`).join(" ")}` : "";
      lines.push(`- ${s.label}${tag}${about}`);
    }
    if (c.more) lines.push(`- (there are ${c.more} more older threads; continuing those goes to the main chat)`);
  }
  if (opts.tasks?.length) {
    lines.push("\n## Background tasks");
    for (const t of opts.tasks) lines.push(`- ${t.id} "${t.title}" ${t.agent} · ${t.status}`);
  }
  if (opts.onlyAgent) lines.push(`\nThe user specified the bot "${opts.onlyAgent}", so you may only continue or new under it.`);
  lines.push(`\nThe user is currently in: ${opts.current ?? "none"}`);
  lines.push(`\nThe user's message:\n${opts.text}`);
  return lines.join("\n");
}

/** Parse and validate the model output; return undefined if invalid, and the caller handles the fallback. */
export function parseDecision(
  raw: string,
  valid: { agents: string[]; targets: string[]; allowNewBao?: boolean; allowReply?: boolean; tasks?: string[] },
): Decision | undefined {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  let d: any;
  try {
    d = JSON.parse(m[0]);
  } catch {
    return undefined;
  }
  const one = parseOne(d, valid);
  if (one) return one;
  if (d.action === "task" && valid.tasks?.includes(d.id) && typeof d.text === "string" && d.text.trim()) {
    return { action: "task", id: d.id, text: d.text.trim(), mode: "chat", reason: d.reason };
  }
  if (d.action === "reply" && valid.allowReply && typeof d.text === "string" && d.text.trim()) {
    return { action: "reply", text: d.text.trim(), mode: "chat", reason: d.reason };
  }
  if (d.action === "split" && Array.isArray(d.parts)) {
    const parts: Part[] = [];
    for (const p of d.parts.slice(0, MAX_PARTS)) {
      const x = p && typeof p === "object" ? parseOne(p, valid) : undefined;
      const text = typeof p?.text === "string" ? p.text.trim() : "";
      if (x && text) parts.push({ ...x, text });
    }
    if (parts.length >= 2) return { action: "split", parts, mode: "chat", reason: d.reason };
    if (parts.length === 1) {
      const { text: _t, ...only } = parts[0]; // if only one item remains, treat it as a normal dispatch; what gets handed over is the user's original message
      return only;
    }
  }
  // If the model still returns options (old habit), take the first valid one directly instead of throwing the question back to the user
  if (Array.isArray(d.options)) {
    for (const o of d.options) {
      const x = o && typeof o === "object" ? parseOne({ ...o, action: o.target ? "continue" : "new", mode: d.mode, taskTitle: d.taskTitle, reason: d.reason }, valid) : undefined;
      if (x) return x;
    }
  }
  return undefined;
}

/** Parse a single continue / new destination; return undefined if invalid. */
function parseOne(d: any, valid: { agents: string[]; targets: string[]; allowNewBao?: boolean }) {
  const mode: Mode = d.mode === "background" ? "background" : "chat";
  const taskTitle = mode === "background" && typeof d.taskTitle === "string" ? d.taskTitle.slice(0, 30) : undefined;
  const doneWhen = mode === "background" && typeof d.doneWhen === "string" && d.doneWhen.trim() ? d.doneWhen.trim().slice(0, 200) : undefined;
  const extra = doneWhen ? { doneWhen } : {};
  if (d.action === "continue" && valid.targets.includes(d.target)) {
    return { action: "continue" as const, target: d.target as string, mode, taskTitle, ...extra, reason: d.reason };
  }
  // Hand to an existing bot: go into its main chat (opening threads is the main chat's job)
  if (d.action === "new" && valid.agents.includes(d.agent)) {
    const main = `${d.agent}/${MAIN_SESSION}`;
    if (valid.targets.includes(main)) return { action: "continue" as const, target: main, mode, taskTitle, ...extra, reason: d.reason };
    return { action: "new" as const, agent: d.agent as string, name: MAIN_SESSION, mode, taskTitle, ...extra, reason: d.reason };
  }
  if (d.action === "new" && valid.allowNewBao && validBaoName(d.agent) && typeof d.newBao === "string" && d.newBao.trim()) {
    return { action: "new" as const, agent: d.agent, name: MAIN_SESSION, mode, taskTitle, ...extra, reason: d.reason, newBao: d.newBao.trim().slice(0, 100) };
  }
  return undefined;
}
