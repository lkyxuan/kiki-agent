// Coding agents running outside Kiki: the Claude Code and Codex sessions you start yourself in a terminal.
// At a few key moments (start, needs your approval, turn finished, closed) they report to Kiki via hooks; Kiki only records state and never interferes:
// which ones are running, which one is waiting on you, what got done — grouped by project folder into the matching bot, shown in the right column, written into the main chat digest and the daily briefing.
//
// How this differs from the Mailroom: the Mailroom receives "messages" (to be routed by Kiki, possibly needing a reply), while this receives "state",
// which arrives frequently (potentially one per tool call), so it never calls a model or goes through Kiki — it only updates cards; only when a turn finishes does a small model compress it into one line.
//
// Data lives under data folder/coders/:
//   sessions.json  recent sessions (one entry each: which folder, which bot, status, recent turns)
//   map.json       folder → bot (auto-picked on first sight, editable in the UI)
//   spool/         when Kiki isn't running, hooks write here first; Kiki picks them up on startup
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type CoderTool = "claude-code" | "codex";
export const TOOL_NAME: Record<CoderTool, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** running means working; waiting means stuck waiting on you (approval or a reply); idle means the turn is done and it's open for the next one; ended means closed */
export type CoderStatus = "running" | "waiting" | "idle" | "ended";
export const CODER_STATUS_LABEL: Record<CoderStatus, string> = { running: "Working", waiting: "Waiting on you", idle: "Turn done", ended: "Ended" };

export interface CoderTurn {
  prompt: string; // what you asked it to do this turn
  result?: string; // the last thing it said this turn (truncated)
  summary?: string; // compressed into one line
  at: string;
  done?: string; // when it finished
}

export interface CoderSession {
  id: string; // tool:session id
  tool: CoderTool;
  session: string;
  cwd: string;
  repo: string; // folder name
  branch?: string;
  host?: string; // which computer
  bao: string;
  status: CoderStatus;
  waitingFor?: "approval" | "reply";
  note?: string; // what it said while waiting on you, e.g. "Claude needs your permission to use Bash"
  title: string; // the first request
  summary?: string; // one line for the most recent finished turn
  turns: CoderTurn[];
  transcript?: string;
  started: string;
  updated: string;
}

/** A normalized event (whether from a Claude Code hook or a Codex notify). */
export interface CoderEvent {
  tool: CoderTool;
  kind: "start" | "prompt" | "waiting" | "working" | "stop" | "end";
  session: string;
  cwd: string;
  host?: string;
  prompt?: string;
  result?: string;
  waitingFor?: "approval" | "reply";
  note?: string;
  transcript?: string;
  at?: string;
}

const MAX_SESSIONS = 200;
const MAX_TURNS = 20;
const cut = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s.trim() : "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const firstLine = (s: string, n = 40) => cut(s.split("\n").find((l) => l.trim()) ?? "", n);

/** Normalize the raw JSON a hook sends into an event; returns undefined for anything unrecognized (events we don't care about). */
export function normalize(tool: string, raw: any, host?: string): CoderEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (tool === "codex") {
    // Codex notify: only agent-turn-complete, carrying this turn's request and final answer
    if (raw.type !== "agent-turn-complete") return undefined;
    const input = Array.isArray(raw["input-messages"]) ? raw["input-messages"].filter((x: unknown) => typeof x === "string").join("\n") : "";
    const session = String(raw["thread-id"] ?? raw["turn-id"] ?? "");
    if (!session) return undefined;
    return { tool: "codex", kind: "stop", session, cwd: String(raw.cwd ?? ""), host, prompt: cut(input, 500), result: cut(raw["last-assistant-message"], 2000) };
  }
  if (tool !== "claude-code") return undefined;
  const session = String(raw.session_id ?? "");
  if (!session) return undefined;
  const base = { tool: "claude-code" as const, session, cwd: String(raw.cwd ?? ""), host, transcript: typeof raw.transcript_path === "string" ? raw.transcript_path : undefined };
  switch (raw.hook_event_name) {
    case "SessionStart":
      return { ...base, kind: "start" };
    case "UserPromptSubmit":
      return { ...base, kind: "prompt", prompt: cut(raw.prompt, 500) };
    case "Notification": {
      const type = String(raw.notification_type ?? "");
      const msg = String(raw.message ?? "");
      // needs permission → waiting on your approval; idle for a while → waiting on your reply. Everything else (login succeeded, etc.) is ignored
      if (type === "permission_prompt" || (!type && /permission/i.test(msg))) return { ...base, kind: "waiting", waitingFor: "approval", note: cut(msg, 200) };
      if (type === "idle_prompt" || (!type && /waiting for your input/i.test(msg))) return { ...base, kind: "waiting", waitingFor: "reply", note: cut(msg, 200) };
      return undefined;
    }
    case "PostToolUse":
      return { ...base, kind: "working" }; // back to work after approval: flip "waiting on you" back to "working"
    case "Stop":
      return { ...base, kind: "stop", result: cut(raw.last_assistant_message, 2000) };
    case "SessionEnd":
      return { ...base, kind: "end" };
  }
  return undefined;
}

export interface CodersOptions {
  dataDir: string;
  listBaos: () => string[];
  defaultBao: string;
  /** when the folder name doesn't match any bot, let the model pick one (otherwise fall back to the default bot) */
  pickBao?: (repo: string, cwd: string, prompt: string) => Promise<string | undefined>;
  /** when a turn finishes, compress the final answer into one line (otherwise take the first line) */
  summarize?: (prompt: string, result: string) => Promise<string>;
}

export class Coders extends EventEmitter {
  readonly dir: string;
  private sessions: CoderSession[] = [];
  private map: Record<string, string> = {};
  private saving?: NodeJS.Timeout;
  private queue: Promise<unknown> = Promise.resolve(); // events are processed one at a time in arrival order: if the first two events of the same session arrive together, only one card is created

  constructor(private opts: CodersOptions) {
    super();
    this.dir = join(opts.dataDir, "coders");
    mkdirSync(join(this.dir, "spool"), { recursive: true });
    try {
      this.sessions = JSON.parse(readFileSync(join(this.dir, "sessions.json"), "utf8"));
    } catch {}
    try {
      this.map = JSON.parse(readFileSync(join(this.dir, "map.json"), "utf8"));
    } catch {}
  }

  list(): CoderSession[] {
    return [...this.sessions].sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** For the UI: anything active in the last 3 days, plus anything still open */
  state() {
    const since = Date.now() - 3 * 86400_000;
    return this.list().filter((s) => s.status !== "ended" || Date.parse(s.updated) > since).slice(0, 40);
  }

  /** Raw JSON sent by a hook. Returns the normalized session (undefined for events we don't care about). */
  async ingest(tool: string, raw: unknown, host?: string, at?: string): Promise<CoderSession | undefined> {
    const ev = normalize(tool, raw, host);
    if (!ev) return undefined;
    return this.apply({ ...ev, at: at ?? ev.at });
  }

  apply(ev: CoderEvent): Promise<CoderSession | undefined> {
    const run = this.queue.then(() => this.applyNow(ev));
    this.queue = run.catch(() => {});
    return run;
  }

  private async applyNow(ev: CoderEvent): Promise<CoderSession | undefined> {
    const id = `${ev.tool}:${ev.session}`;
    const now = ev.at ?? new Date().toISOString();
    let s = this.sessions.find((x) => x.id === id);
    if (!s) {
      if (ev.kind === "working" || ev.kind === "end") return undefined; // never saw the start, so don't create a card for a single tool call
      const repo = basename(ev.cwd) || ev.cwd || "?";
      s = { id, tool: ev.tool, session: ev.session, cwd: ev.cwd, repo, host: ev.host, bao: await this.baoFor(ev.cwd, ev.prompt ?? ""), status: "idle", title: "", turns: [], started: now, updated: now };
      s.branch = await gitBranch(ev.cwd);
      this.sessions.push(s);
      if (this.sessions.length > MAX_SESSIONS) this.sessions = this.list().slice(0, MAX_SESSIONS);
    } else if (ev.kind === "working" && s.status !== "waiting") return s; // tool call during normal work: no change, no save
    if (ev.transcript) s.transcript = ev.transcript;
    const last = s.turns[s.turns.length - 1];
    switch (ev.kind) {
      case "start":
        if (s.status === "ended") s.status = "idle";
        break;
      case "prompt":
        s.turns.push({ prompt: ev.prompt ?? "", at: now });
        if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
        s.title ||= firstLine(ev.prompt ?? "");
        s.status = "running";
        s.waitingFor = s.note = undefined;
        break;
      case "waiting":
        s.status = "waiting";
        s.waitingFor = ev.waitingFor;
        s.note = ev.note;
        break;
      case "working":
        s.status = "running";
        s.waitingFor = s.note = undefined;
        break;
      case "stop": {
        // Codex has no separate "start"; the request and result arrive together
        const turn = ev.prompt !== undefined || !last || last.done ? { prompt: ev.prompt ?? "", at: now } : last;
        if (turn !== last) {
          s.turns.push(turn);
          if (s.turns.length > MAX_TURNS) s.turns.splice(0, s.turns.length - MAX_TURNS);
        }
        turn.result = ev.result;
        turn.done = now;
        s.title ||= firstLine(turn.prompt);
        s.status = "idle";
        s.waitingFor = s.note = undefined;
        s.summary = firstLine(ev.result ?? "", 60);
        turn.summary = s.summary;
        if (this.opts.summarize && ev.result && ev.result.length > 60) void this.summarize(s, turn);
        break;
      }
      case "end":
        s.status = "ended";
        s.waitingFor = s.note = undefined;
        break;
    }
    s.updated = now;
    this.changed(s, ev.kind);
    return s;
  }

  private async summarize(s: CoderSession, turn: CoderTurn) {
    try {
      const one = firstLine(await this.opts.summarize!(turn.prompt, turn.result ?? ""), 60);
      if (!one) return;
      turn.summary = one;
      if (s.turns[s.turns.length - 1] === turn) s.summary = one;
      this.changed(s, "summary");
    } catch {}
  }

  private changed(s: CoderSession, kind: string) {
    clearTimeout(this.saving);
    this.saving = setTimeout(() => this.save(), 300);
    this.emit("change", s, kind);
  }

  save() {
    clearTimeout(this.saving);
    const write = (name: string, data: unknown) => {
      const f = join(this.dir, name);
      writeFileSync(`${f}.tmp`, JSON.stringify(data, null, 1));
      renameSync(`${f}.tmp`, f);
    };
    write("sessions.json", this.sessions);
    write("map.json", this.map);
  }

  /** Which bot a folder belongs to: remembered (longest prefix) → folder name matches a bot name → let the model pick → default bot. Remember the choice. */
  async baoFor(cwd: string, prompt = ""): Promise<string> {
    const baos = this.opts.listBaos();
    const known = Object.keys(this.map)
      .filter((k) => cwd === k || cwd.startsWith(k.endsWith("/") ? k : `${k}/`))
      .sort((a, b) => b.length - a.length)[0];
    if (known && baos.includes(this.map[known])) return this.map[known];
    const repo = basename(cwd).toLowerCase();
    let pick: string | undefined;
    if (repo.length >= 2) {
      pick = baos.find((b) => b.toLowerCase() === repo);
    }
    if (!pick && this.opts.pickBao) pick = await this.opts.pickBao(basename(cwd), cwd, prompt).catch(() => undefined);
    if (!pick || !baos.includes(pick)) pick = this.opts.defaultBao;
    if (cwd) this.map[cwd] = pick;
    return pick;
  }

  /** Reassign in the UI: this folder belongs to this bot from now on, and existing sessions move with it. */
  setBao(cwd: string, bao: string) {
    if (!this.opts.listBaos().includes(bao)) throw new Error(`There is no bot named "${bao}"`);
    this.map[cwd] = bao;
    for (const s of this.sessions) if (s.cwd === cwd || s.cwd.startsWith(`${cwd}/`)) s.bao = bao;
    this.save();
    this.emit("change");
  }

  /** The line the bot's main chat sees each turn: how many are running outside, how many are waiting on you */
  digest(bao?: string): string {
    const open = this.state().filter((s) => s.status !== "ended" && (!bao || s.bao === bao) && Date.parse(s.updated) > Date.now() - 86400_000);
    if (!open.length) return "";
    const line = (s: CoderSession) =>
      `- ${TOOL_NAME[s.tool]} · ${s.repo}${s.bao && !bao ? ` (${s.bao})` : ""}: ${CODER_STATUS_LABEL[s.status]}${s.waitingFor === "approval" ? " approval" : ""} · ${s.title || "(nothing requested yet)"}${s.summary ? ` → ${s.summary}` : ""}`;
    return `[Coding agents the user started in a terminal] (read-only, not yours to manage; you may mention them if the user asks)\n${open.slice(0, 8).map(line).join("\n")}`;
  }

  /** For the daily briefing: turns finished in the past day, and anything still waiting on you */
  briefingLines(now = new Date()): { done: string[]; waiting: string[] } {
    const since = now.getTime() - 86400_000;
    const done: string[] = [];
    const waiting: string[] = [];
    for (const s of this.list()) {
      const n = s.turns.filter((t) => t.done && Date.parse(t.done) >= since).length;
      if (n) done.push(`- ${TOOL_NAME[s.tool]} finished ${n} turn(s) in ${s.repo}: ${s.summary || s.title}`);
      if (s.status === "waiting") waiting.push(`- ${TOOL_NAME[s.tool]} in ${s.repo} is waiting on your ${s.waitingFor === "approval" ? "approval" : "reply"}: ${s.title}`);
    }
    return { done: done.slice(0, 8), waiting };
  }

  /** Written by the hook while Kiki is off (spool/*.jsonl, one {tool, host, at, event} per line); collected on startup. */
  async drainSpool() {
    const dir = join(this.dir, "spool");
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      const file = join(dir, f);
      const taking = `${file}.${process.pid}.taking`;
      try {
        renameSync(file, taking);
      } catch {
        continue;
      }
      n += await this.ingestLines(readFileSync(taking, "utf8"));
      unlinkSync(taking);
    }
    return n;
  }

  /** One per line: {tool, host, at, event}. Used by both remote machine resends and the local spool */
  async ingestLines(text: string) {
    let n = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (await this.ingest(String(r.tool ?? ""), r.event, typeof r.host === "string" ? r.host : undefined, typeof r.at === "string" ? r.at : undefined)) n++;
      } catch {}
    }
    return n;
  }
}

async function gitBranch(cwd: string): Promise<string | undefined> {
  if (!cwd || !existsSync(cwd)) return undefined; // folder on another computer, not visible from this one
  try {
    const { stdout } = await run("git", ["-C", cwd, "branch", "--show-current"], { timeout: 2000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Command to resume this session (click the card to copy) */
export function resumeCommand(s: Pick<CoderSession, "tool" | "session" | "cwd">): string {
  const cd = s.cwd ? `cd ${shq(s.cwd)} && ` : "";
  return s.tool === "codex" ? `${cd}codex resume ${s.session}` : `${cd}claude --resume ${s.session}`;
}

export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
