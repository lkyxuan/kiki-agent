// Work: the things a bot is doing (what needs to get done, where it stands, the next step).
// The threads in the left column are "where we talked", ordered by time; work is "what needs to get done", ordered by goal. One piece of work may be spread across several conversations,
// and one conversation may spawn two pieces of work; idle chat doesn't produce work. Task cards are the individual runs within a piece of work, attached under the work's conversations.
// After each conversation has been replied to and its summary written, the "work classification" role (which can use its own small model) files it into work on behalf of the bot's main chat:
// merge into an existing one, create a new one, or decide it isn't work. Stored in agents/<bot>/work/<id>.md; the header is the status, the body is the goal and progress, and it can be edited by hand.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export const WORK_STATUS = ["doing", "watching", "todo", "done", "dropped"] as const;
export type WorkStatus = (typeof WORK_STATUS)[number];
export const STATUS_NAME: Record<WorkStatus, string> = { doing: "In progress", watching: "Watching", todo: "To do", done: "Done", dropped: "Dropped" };

export interface Work {
  id: string;
  agent: string;
  title: string;
  status: WorkStatus;
  goal?: string; // what needs to get done
  doneWhen?: string; // what counts as finished
  next?: string; // next step (who does what)
  threads: string[]; // related conversations (pi JSONL paths); tasks are attached via conversations
  left?: string[]; // conversations you moved out by hand; classification won't merge them back
  progress: { at: string; text: string }[]; // progress, one line per event
  created: string;
  updated: string;
}

// ---------- Storage: one .md per piece of work ----------

const KEYS = ["id", "agent", "title", "status", "goal", "doneWhen", "next", "threads", "left", "created", "updated"] as const;

export function renderWork(w: Work): string {
  // Each header value is written as JSON (which is also valid YAML), so Chinese text, quotes and colons need no escaping
  const head = KEYS.filter((k) => w[k] !== undefined && !(Array.isArray(w[k]) && !(w[k] as string[]).length && k === "left"))
    .map((k) => `${k}: ${JSON.stringify(w[k])}`)
    .join("\n");
  const top = [`# ${w.title}`, w.goal && `Goal: ${w.goal}`, w.doneWhen && `Done when: ${w.doneWhen}`, w.next && `Next step: ${w.next}`].filter(Boolean).join("\n\n");
  const log = w.progress.map((p) => `- ${p.at} ${p.text}`).join("\n");
  return `---\n${head}\n---\n\n${top}\n\n## Progress\n${log}\n`;
}

export function parseWork(text: string): Work | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return undefined;
  const o: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const raw = line.slice(i + 1).trim();
    try {
      o[line.slice(0, i).trim()] = JSON.parse(raw);
    } catch {
      o[line.slice(0, i).trim()] = raw; // hand-edited to unquoted YAML; accept that too
    }
  }
  if (typeof o.id !== "string" || typeof o.title !== "string") return undefined;
  const progress: Work["progress"] = [];
  const sec = m[2].split(/^## Progress\s*$/m)[1] ?? "";
  for (const line of sec.split("\n")) {
    const p = line.match(/^- (\S+ \S+|\S+) (.+)$/);
    if (p) progress.push({ at: p[1], text: p[2].trim() });
  }
  return {
    id: o.id,
    agent: String(o.agent ?? ""),
    title: o.title,
    status: WORK_STATUS.includes(o.status as WorkStatus) ? (o.status as WorkStatus) : "doing",
    goal: str(o.goal),
    doneWhen: str(o.doneWhen),
    next: str(o.next),
    threads: arr(o.threads),
    left: arr(o.left),
    progress,
    created: String(o.created ?? ""),
    updated: String(o.updated ?? o.created ?? ""),
  };
}
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export class WorkBook extends EventEmitter {
  constructor(private agentDir: (agent: string) => string) {
    super();
  }

  private dir(agent: string) {
    return join(this.agentDir(agent), "work");
  }

  list(agent: string): Work[] {
    const dir = this.dir(agent);
    if (!existsSync(dir)) return [];
    const out: Work[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const w = parseWork(readFileSync(join(dir, f), "utf8"));
        if (w) out.push({ ...w, agent });
      } catch {
        /* skip bad files */
      }
    }
    return out.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  get(agent: string, id: string): Work | undefined {
    const f = join(this.dir(agent), `${id}.md`);
    if (!/^[\w-]+$/.test(id) || !existsSync(f)) return undefined;
    const w = parseWork(readFileSync(f, "utf8"));
    return w && { ...w, agent };
  }

  save(w: Work) {
    mkdirSync(this.dir(w.agent), { recursive: true });
    const f = join(this.dir(w.agent), `${w.id}.md`);
    writeFileSync(`${f}.tmp`, renderWork(w));
    renameSync(`${f}.tmp`, f);
    this.emit("change", w.agent);
  }

  create(agent: string, init: Partial<Work> & { title: string }, now = new Date()): Work {
    const id = `w${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const w: Work = { status: "doing", threads: [], progress: [], ...init, id, agent, created: now.toISOString(), updated: now.toISOString() };
    this.save(w);
    return w;
  }

  /** Which pieces of work this conversation belongs to */
  ofThread(agent: string, path: string): Work[] {
    return this.list(agent).filter((w) => w.threads.includes(path));
  }

  // ---------- Your manual edits ----------

  /** Merge from into into: conversations and progress combined, from deleted */
  merge(agent: string, from: string, into: string): Work | undefined {
    const a = this.get(agent, from), b = this.get(agent, into);
    if (!a || !b || a.id === b.id) return undefined;
    b.threads = [...new Set([...b.threads, ...a.threads])];
    b.progress = [...b.progress, ...a.progress].sort((x, y) => x.at.localeCompare(y.at));
    b.progress.push({ at: stamp(), text: `Merged in "${a.title}"` });
    b.updated = new Date().toISOString();
    this.save(b);
    unlinkSync(join(this.dir(agent), `${a.id}.md`));
    this.emit("change", agent);
    return b;
  }

  /** Move a conversation out of a piece of work (split it off); classification won't merge it back into this one later */
  detach(agent: string, id: string, path: string): Work | undefined {
    const w = this.get(agent, id);
    if (!w) return undefined;
    w.threads = w.threads.filter((p) => p !== path);
    w.left = [...new Set([...(w.left ?? []), path])];
    w.updated = new Date().toISOString();
    this.save(w);
    return w;
  }

  set(agent: string, id: string, patch: { status?: WorkStatus; title?: string }): Work | undefined {
    const w = this.get(agent, id);
    if (!w) return undefined;
    if (patch.status && WORK_STATUS.includes(patch.status) && patch.status !== w.status) {
      w.progress.push({ at: stamp(), text: `You marked it "${STATUS_NAME[patch.status]}"` });
      w.status = patch.status;
    }
    if (patch.title?.trim()) w.title = patch.title.trim().slice(0, 40);
    w.updated = new Date().toISOString();
    this.save(w);
    return w;
  }

  /** Main chat was cleared and switched to a new file: follow it in work */
  repoint(agent: string, from: string, to: string) {
    for (const w of this.ofThread(agent, from)) {
      w.threads = w.threads.map((p) => (p === from ? to : p));
      this.save(w);
    }
  }

  /** Conversation deleted: remove it from all work (the work itself stays, progress is kept) */
  forget(agent: string, path: string) {
    for (const w of this.ofThread(agent, path)) {
      w.threads = w.threads.filter((p) => p !== path);
      this.save(w);
    }
  }

  // ---------- Classification results written in ----------

  /** Write the model's classification results to files. Returns the work that changed */
  apply(agent: string, path: string, items: Classified[], now = new Date()): Work[] {
    const open = this.list(agent);
    const out: Work[] = [];
    for (const it of items.slice(0, 3)) {
      let w = it.work && it.work !== "new" ? open.find((x) => x.id === it.work) : undefined;
      if (w?.left?.includes(path)) continue; // you split it out before; don't merge it back
      if (w?.status === "dropped") continue; // you said you're not doing it; auto-classification won't change it
      if (!w) {
        if (!it.title) continue;
        if (open.some((x) => x.title === it.title && x.status === "dropped")) continue; // and don't create a new one under a different id
        // Treat same-title as the same piece, so the model forgetting the id doesn't create a duplicate
        w = open.find((x) => x.title === it.title && x.status !== "done" && x.status !== "dropped" && !x.left?.includes(path));
        if (!w) {
          w = this.create(agent, { title: it.title.slice(0, 40), threads: [path] }, now);
          open.push(w);
        }
      }
      if (!w.threads.includes(path)) w.threads.push(path);
      if (it.title && w.title !== it.title && !w.progress.length) w.title = it.title.slice(0, 40); // a freshly created one can still be renamed; once there's progress, don't change it
      if (it.goal) w.goal = it.goal;
      if (it.doneWhen) w.doneWhen = it.doneWhen;
      if (it.next !== undefined) w.next = it.next || undefined;
      if (it.status && WORK_STATUS.includes(it.status)) w.status = it.status;
      const last = w.progress[w.progress.length - 1];
      if (it.progress && it.progress !== last?.text) w.progress.push({ at: stamp(now), text: it.progress.slice(0, 80) });
      w.progress = w.progress.slice(-30);
      w.updated = now.toISOString();
      this.save(w);
      out.push(w);
    }
    return out;
  }
}

// ---------- Classification: done by a cheap model on behalf of the bot's main chat ----------

export interface Classified {
  work?: string; // id of an existing piece of work; "new" means create one
  title?: string;
  goal?: string;
  doneWhen?: string;
  status?: WorkStatus;
  next?: string;
  progress?: string;
}

export const WORK_SYSTEM = `You are the project manager for a bot (an assistant responsible for a certain domain). The user chats in conversations on the left; your job is to organize the things that need to get done in those conversations into "work": a piece of work is something that needs to get done, with a goal, a status and a next step.
Look at the recent content of this conversation and compare it against this bot's existing work to decide which piece of work it belongs to:
- If it belongs to an existing one, use that one's id; if it's a new thing that needs to get done, set work to "new";
- If it's just idle chat, Q&A, looking something up, with nothing that needs to get done, output an empty array [];
- One conversation can spawn at most 3 pieces of work; most have only 1.
Output only a JSON array, with these fields per item:
{"work": "existing id or new", "title": "an 8 to 14 character name for the thing, like a to-do title", "goal": "what needs to get done, one sentence", "doneWhen": "what counts as finished, one sentence", "status": "doing|watching|todo|done|dropped", "next": "who does what next, one sentence; empty string if none", "progress": "one sentence on the new progress this time, no more than 30 characters; omit if there's no new progress"}
status: doing = in progress; watching = finished but still keeping an eye on something; todo = agreed to do later; done = finished; dropped = the user said they're not doing it.
Existing fields that haven't changed can be omitted; don't make up things that aren't in the conversation.
Anything marked "Dropped" was cancelled by the user; if the conversation is still talking about it, use its id and don't create a new one.`;

export function buildWorkInput(o: { agent: string; thread: string; summary?: string; lines: { role: string; text: string }[]; works: Work[]; mine: string[] }): string {
  const works = o.works
    .filter((w) => (w.status !== "dropped" && w.status !== "done") || o.mine.includes(w.id)) // for done/dropped ones, only include those this conversation is already in
    .slice(0, 20)
    .map((w) => `- id=${w.id}${o.mine.includes(w.id) ? " (this conversation is already in it)" : ""} | ${w.title} | ${STATUS_NAME[w.status]}${w.next ? ` | Next step: ${w.next}` : ""}`)
    .join("\n");
  const body = o.lines
    .slice(-12)
    .map((l) => `${l.role === "user" ? "User" : "Assistant"}: ${l.text.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  return `Bot: ${o.agent}\nConversation name: ${o.thread}\nConversation summary: ${o.summary ?? "(none)"}\n\nThis bot's existing work:\n${works || "(none yet)"}\n\nRecent content of this conversation:\n${body}`;
}

/** Clean the model output into an array; if it can't be recognized, treat it as none */
export function parseClassified(raw: string): Classified[] | undefined {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return undefined;
  try {
    const v = JSON.parse(m[0]);
    if (!Array.isArray(v)) return undefined;
    return v
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        work: str(x.work),
        title: str(x.title),
        goal: str(x.goal),
        doneWhen: str(x.doneWhen),
        status: WORK_STATUS.includes(x.status) ? x.status : undefined,
        next: typeof x.next === "string" ? x.next.trim() : undefined,
        progress: str(x.progress),
      }));
  } catch {
    return undefined;
  }
}

export class WorkSorter {
  private running = new Set<string>();
  private again = new Set<string>();

  constructor(
    private o: {
      book: WorkBook;
      thread: (path: string) => { agent: string; name: string; summary?: string } | undefined;
      history: (path: string) => { role: string; text: string }[];
      complete: (system: string, user: string) => Promise<string>;
      skip?: (path: string) => boolean; // conversations not to classify (e.g. background conversations spawned by tasks; the task itself is attached under the work of the conversation that started it)
    },
  ) {}

  async run(path: string): Promise<Work[]> {
    if (this.running.has(path)) {
      this.again.add(path);
      return [];
    }
    this.running.add(path);
    try {
      const rec = this.o.thread(path);
      if (!rec || this.o.skip?.(path)) return [];
      const lines = this.o.history(path);
      if (!lines.length) return [];
      const works = this.o.book.list(rec.agent);
      const mine = works.filter((w) => w.threads.includes(path)).map((w) => w.id);
      let items: Classified[] | undefined;
      try {
        items = parseClassified(await this.o.complete(WORK_SYSTEM, buildWorkInput({ agent: rec.agent, thread: rec.name, summary: rec.summary, lines, works, mine })));
      } catch (e) {
        console.warn("[work] classification failed:", (e as Error).message);
      }
      // While waiting on the model, the conversation may have been deleted or cleared and swapped to another file: discard this result so a deleted conversation doesn't get added back into Work
      if (!items || this.o.thread(path)?.agent !== rec.agent) return [];
      return this.o.book.apply(rec.agent, path, items);
    } finally {
      this.running.delete(path);
      if (this.again.delete(path)) void this.run(path);
    }
  }
}
