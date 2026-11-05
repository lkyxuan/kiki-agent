// Background tasks (the execution part of the second routing layer): one task = one Markdown file under tasks/ in the data folder.
// Follows OpenClaw's spawn + announce: open a background conversation to do the work, then report the result back to where it was started.
// No database, no polling: Kiki is a single process, so incoming tasks queue up and run directly; for scheduled tasks, only the one due soonest gets an alarm.
// Storage is isolated behind TaskStore, so when we need queries and stats later we only swap this layer (e.g. for SQLite).
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextRun } from "./schedule.js";

export type TaskStatus = "todo" | "queued" | "running" | "blocked" | "done" | "failed" | "interrupted" | "cancelled";

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  queued: "Queued",
  running: "In progress",
  blocked: "Waiting on you",
  done: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

/** Statuses that haven't finished yet (watch out for these on restart or update). */
export const OPEN: TaskStatus[] = ["todo", "queued", "running", "blocked"];

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  agent: string; // which bot does it
  prompt: string; // the exact words handed to the background conversation
  session?: string; // the background conversation running this task (pi JSONL path)
  origin?: string; // which conversation it was dispatched from: fork it to do the work, then report back there
  reportTo?: string; // report only, no fork: report back to this conversation when done (takes priority over origin), e.g. handoff
  chatId?: string; // which chat it was dispatched from (inbox)
  created: string;
  started?: string;
  finished?: string;
  result?: string; // the answer when done, the reason when failed
  when?: string; // todo: don't start until this time (ISO); for repeating tasks, the next run time
  after?: string; // todo: wait until this task is done before starting (task id)
  repeat?: string; // repeat rule, e.g. "every day at 09:00" (see schedule.ts). A task with this is the "scheduled task" itself; each time it's due, a separate task is opened to run
  parent?: string; // which scheduled task opened it
  question?: string; // waiting on you: where it's stuck, what you need to answer
  hold?: boolean; // just record it: whether or not it's due and whether or not the tasks it waits on are done, wait for the user to press start
  doneWhen?: string; // completion criteria: what counts as done
  executor?: string; // who does it: leave empty and Kiki opens a background conversation itself; fill in an external bot's name to hand it to an executor registered with the Mailroom
  watching?: string; // what to keep watching after it's done (an entry in the watchlist); when related new messages arrive, go back to this task's conversation and continue
}

// ---------- Storage ----------

export interface TaskStore {
  load(): Task[];
  save(t: Task): void;
}

/** One .md per task: YAML at the top is the status, the body is the task and result; open it to read, edit it by hand. */
export class FileTaskStore implements TaskStore {
  private files = new Map<string, string>(); // id -> file name

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  load(): Task[] {
    const out: Task[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".md")) continue;
      try {
        const t = parseTask(readFileSync(join(this.dir, f), "utf8"));
        if (t) {
          this.files.set(t.id, f);
          out.push(t);
        }
      } catch (e) {
        console.warn(`[tasks] Could not parse ${f}: ${(e as Error).message}`);
      }
    }
    return out.sort((a, b) => a.created.localeCompare(b.created));
  }

  save(t: Task) {
    const name = this.files.get(t.id) ?? `${t.id} ${safe(t.title)}.md`;
    this.files.set(t.id, name);
    const file = join(this.dir, name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, formatTask(t));
    renameSync(tmp, file); // write to a temp file then rename, to avoid half-written files
  }
}

/** For tests: in-memory only. */
export class MemoryTaskStore implements TaskStore {
  private m = new Map<string, Task>();
  load() {
    return [...this.m.values()];
  }
  save(t: Task) {
    this.m.set(t.id, { ...t });
  }
}

const RESULT_MARK = "<!-- kiki:result -->";
const FIELDS = [
  "id", "title", "status", "agent", "when", "after", "repeat", "parent", "question", "hold", "doneWhen", "executor", "watching",
  "session", "origin", "reportTo", "chatId", "created", "started", "finished",
] as const;

export function formatTask(t: Task): string {
  const head = FIELDS.filter((k) => t[k] !== undefined).map((k) => `${k}: ${JSON.stringify(t[k])}`);
  let body = `---\n${head.join("\n")}\n---\n\n## Task\n\n${t.prompt}\n`;
  if (t.result !== undefined) body += `\n${RESULT_MARK}\n## Result\n\n${t.result}\n`;
  return body;
}

export function parseTask(text: string): Task | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return undefined;
  const t: any = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    try {
      t[k] = JSON.parse(raw);
    } catch {
      t[k] = raw; // accept unquoted values from hand edits too
    }
  }
  if (!t.id || !t.status || !t.agent) return undefined;
  // Use a marker line to separate task and result, so a "## Result" inside the task text won't truncate it
  const body = m[2];
  const r = body.indexOf(`\n${RESULT_MARK}\n`);
  const taskPart = r >= 0 ? body.slice(0, r) : body;
  t.prompt = taskPart.replace(/^\s*## Task\s*\n/, "").trim();
  if (r >= 0) t.result = body.slice(r + RESULT_MARK.length + 2).replace(/^## Result\s*\n/, "").trim();
  t.title ??= t.id;
  t.created ??= "";
  return t as Task;
}

const safe = (s: string) => s.replace(/[\/\\:*?"<>|\n]/g, " ").trim().slice(0, 30) || "task";

// ---------- Execution ----------

/** Everything the executor needs from the outside world; tests can swap in a fake. */
/** External executor (an external bot in the Mailroom): takes the task, does it, returns the result. Timeouts, retries and reporting all reuse the task's rules. */
export interface Executor {
  /** signal: aborted when the task is stopped or times out; the executor should tell the other side to stop too, then just reject */
  run(t: Task, signal: AbortSignal): Promise<string>;
  /** Stop (called when stopping the task); optional; not needed if you use signal */
  stop?(t: Task): Promise<void> | void;
}

/** The full instructions handed to the executor: the task text + completion criteria. */
export function taskPrompt(t: Pick<Task, "prompt" | "doneWhen">): string {
  return t.doneWhen ? `${t.prompt}\n\nCompletion criteria: ${t.doneWhen}\nStop once you reach this point, and in the result go through the completion criteria one by one saying whether each was met.` : t.prompt;
}

export interface TaskBackend {
  /** Open a background conversation for this task under this bot and return its JSONL path; if from is given, fork from that conversation */
  spawn(agent: string, title: string, from?: string): Promise<string>;
  send(agent: string, path: string, text: string): Promise<string>;
  /** Stop a running conversation (for timeouts and stopping tasks); optional */
  abort?(path: string): Promise<void>;
  /** Insert a message into a running conversation (for editing tasks); optional */
  steer?(path: string, text: string): Promise<void>;
  /** Append a message to the end of a conversation without triggering a reply (report back to the originating conversation) */
  note(path: string, text: string): Promise<void>;
}

export interface StartInput {
  agent: string;
  title: string;
  prompt: string;
  origin?: string;
  reportTo?: string;
  chatId?: string;
  when?: string; // ISO; if in the future, put it in todo first
  after?: string; // wait until this task is done
  repeat?: string; // repeat rule; with this it's a scheduled task
  hold?: boolean; // just record it, wait for a manual start
  parent?: string;
  doneWhen?: string;
  executor?: string;
}

type Notify = (t: Task) => void;

/** Events: update(task) on every status change. */
export class Tasks extends EventEmitter {
  private all = new Map<string, Task>();
  private running = 0;
  private waiting: string[] = [];
  private notifiers = new Map<string, Notify>();
  private asked = new Map<string, string>(); // task id -> the question the agent asked during this round
  private resumes = new Map<string, string>(); // task id -> the user's answer or rework request (queued to continue in the original conversation)
  private stopping = new Set<string>(); // tasks being stopped: marked "cancelled" when this round ends
  private executors = new Map<string, Executor>();
  private controllers = new Map<string, AbortController>(); // task id -> the stop signal handed to the external executor
  /** Look up an executor by name (Mailroom external agents are dynamic, so this avoids re-registering every time); checks registerExecutor registrations first */
  executorFor?: (name: string) => Executor | undefined;
  private timer?: NodeJS.Timeout;
  /** For tasks with no dedicated report target (opened by a schedule, after a restart, recorded by an agent tool), this is called when they finish or get stuck; the server routes it to the inbox. */
  defaultNotify?: Notify;

  constructor(
    private store: TaskStore,
    private backend: TaskBackend,
    private opts: { concurrency?: number; timeoutMs?: number; now?: () => Date } = {},
  ) {
    super();
    for (const t of store.load()) this.all.set(t.id, t);
    // Set the alarm after recover(): mark the ones interrupted last time first, so freshly released tasks aren't treated as interrupted
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Register an external executor with the Mailroom (the name is the executor on the task card). Registering the same name again overwrites. */
  registerExecutor(name: string, ex: Executor) {
    this.executors.set(name, ex);
  }

  private executor(name: string): Executor | undefined {
    return this.executors.get(name) ?? this.executorFor?.(name);
  }

  /** Stop an external executor: send the stop signal first, then call its stop (if any). */
  private async stopExecutor(t: Task) {
    this.controllers.get(t.id)?.abort();
    await this.executor(t.executor!)?.stop?.(t);
  }

  /** Call once at startup: mark unfinished tasks from last time (queued/running) as "interrupted" and return them so the caller can tell the user. Todo and waiting-on-you tasks stay as they are. */
  recover(): Task[] {
    const out: Task[] = [];
    for (const t of this.all.values()) {
      if (t.status === "queued" || t.status === "running") {
        this.update(t, { status: "interrupted", finished: iso(this.now()), result: "This task hadn't finished when Kiki restarted." });
        out.push(t);
      }
    }
    this.tick(); // catch up on todos that came due while shut down
    return out;
  }

  list(filter?: (t: Task) => boolean): Task[] {
    return [...this.all.values()].filter((t) => !filter || filter(t));
  }

  get(id: string): Task | undefined {
    return this.all.get(id);
  }

  /** Dispatch a task. Returns immediately: if it can run, it queues/starts; if it has a time, waits on another task, or is just recorded, it goes to todo. */
  start(input: StartInput, notify?: Notify): Task {
    const { hold: holdIn, ...rest } = input;
    const hold = holdIn || undefined;
    if (rest.after && !this.all.has(rest.after)) throw new Error(`No task ${rest.after}`);
    if (rest.repeat) {
      const first = rest.when ? new Date(rest.when) : nextRun(rest.repeat, this.now());
      if (!first) throw new Error(`Could not understand repeat rule "${rest.repeat}". You can write: every day at 09:00, weekdays at 09:00, every Monday at 09:00, every hour`);
      rest.when = iso(first);
    }
    const t: Task = { id: newId(), status: "todo", created: iso(this.now()), ...rest, ...(hold ? { hold } : {}) };
    this.all.set(t.id, t);
    if (notify) this.notifiers.set(t.id, notify);
    if (!t.repeat && this.ready(t)) this.enqueue(t);
    else this.update(t, {});
    this.arm();
    return t;
  }

  /** Re-run a failed or interrupted task: open a new task with the same text and run it right away. */
  retry(id: string, notify?: Notify): Task | undefined {
    const old = this.all.get(id);
    if (!old || OPEN.includes(old.status) || old.repeat) return undefined;
    return this.start({ agent: old.agent, title: old.title, prompt: old.prompt, doneWhen: old.doneWhen, executor: old.executor, origin: old.origin, reportTo: old.reportTo, chatId: old.chatId, parent: old.parent }, notify);
  }

  /** Start a todo right now (for a scheduled task, this runs an extra time now without affecting the next run time). */
  runNow(id: string, notify?: Notify): Task | undefined {
    const t = this.all.get(id);
    if (!t || t.status !== "todo") return undefined;
    if (notify) this.notifiers.set(t.id, notify);
    if (t.repeat) return this.spawnRun(t);
    this.update(t, { when: undefined, after: undefined, hold: undefined });
    this.enqueue(t);
    this.arm();
    return t;
  }

  /** Cancel a task that hasn't started or is waiting on you (cancelling a scheduled task means it won't run when next due). */
  cancel(id: string): Task | undefined {
    const t = this.all.get(id);
    if (!t || !["todo", "queued", "blocked"].includes(t.status)) return undefined;
    this.waiting = this.waiting.filter((x) => x !== id);
    this.resumes.delete(id);
    this.update(t, { status: "cancelled", finished: iso(this.now()) });
    this.notifiers.delete(id);
    this.settleDependents(t);
    this.arm();
    return t;
  }

  /** The agent in a background conversation is stuck and needs to ask the user: record the question, and when this round finishes the task stops at "waiting on you". Returns undefined if it's not a background task's conversation. */
  ask(sessionPath: string, question: string): Task | undefined {
    const t = this.list((x) => x.session === sessionPath && x.status === "running")[0];
    if (t) this.asked.set(t.id, question.trim());
    return t;
  }

  /** The task that is waiting for your answer and is run by this conversation. */
  /** Which task this conversation belongs to (the most recent one) */
  bySession(sessionPath: string): Task | undefined {
    return this.list((x) => x.session === sessionPath).at(-1);
  }

  /** Record / clear what a task is watching (used by kiki_watch) */
  setWatching(id: string, about: string | undefined) {
    const t = this.all.get(id);
    if (t) this.update(t, { watching: about });
  }

  /** There's new news about what's being watched (called by the Mailroom after a match): go back to this task's original conversation and continue, then report again when done.
   *  For running tasks, insert the message; for waiting-on-you or finished tasks, continue with the new message; for tasks not yet started, add it to the task text. */
  followUp(id: string, message: string, notify?: Notify): string | undefined {
    const t = this.all.get(id);
    const msg = message.trim();
    if (!t || !msg) return undefined;
    const say = `There's new news about what you're watching (${t.watching ?? t.title}):\n\n${msg}\n\nSee what needs doing now: handle what you can yourself, and if unsure, finish it under the most reasonable assumption and then explain; only use kiki_ask_user when you're missing something only the user has (verification code, photo, their own login); if this no longer needs watching, use kiki_watch action=stop.`;
    if (notify) this.notifiers.set(t.id, notify);
    switch (t.status) {
      case "todo":
      case "queued":
        if (this.resumes.has(t.id)) this.resumes.set(t.id, `${this.resumes.get(t.id)}\n\n${say}`);
        else this.update(t, { prompt: `${t.prompt}\n\n${say}` });
        return "Added to the task text";
      case "running":
        if (t.executor || !t.session || !this.backend.steer) return undefined;
void this.backend.steer(t.session, say).catch((e) => console.warn(`[tasks] Failed to interject: ${(e as Error).message}`));
        return "Interjected into the running task";
      default:
        if (t.executor || !t.session || t.status === "cancelled") return undefined;
        this.resumes.set(t.id, say);
        this.update(t, { finished: undefined, result: undefined, question: undefined });
        this.enqueue(t);
        return "Back in the original conversation, continuing the work";
    }
  }

  blockedBySession(sessionPath: string): Task | undefined {
    return this.list((x) => x.session === sessionPath && x.status === "blocked")[0];
  }

  /** Answer a blocked task: continue in the same background conversation. */
  answer(id: string, text: string, notify?: Notify): Task | undefined {
    const t = this.all.get(id);
    if (!t || t.status !== "blocked" || !t.session) return undefined;
    if (notify) this.notifiers.set(t.id, notify);
    this.resumes.set(t.id, text); // queue like any other task, respecting the concurrency limit
    this.update(t, { question: undefined });
    this.enqueue(t);
    return t;
  }

  /** Stop a task: cancel it directly if it hasn't started; if running, stop the conversation (or external executor), and mark it "cancelled" when this round ends. */
  async stop(id: string): Promise<Task | undefined> {
    const t = this.all.get(id);
    if (!t) return undefined;
    if (t.status !== "running") return this.cancel(id);
    this.stopping.add(id);
    if (t.executor) await this.stopExecutor(t);
    else if (t.session) await this.backend.abort?.(t.session);
    return t;
  }

  /** Revise / rework a task: based on the task's current state, send this message where it needs to go. Returns a human-readable note; returns undefined if it can't be revised.
   *  Todo/queued: amend the task content; running: interject into the running conversation; waiting on you: treat as an answer; finished: continue in the original conversation and report again when done. */
  revise(id: string, text: string, notify?: Notify): string | undefined {
    const t = this.all.get(id);
    const add = text.trim();
    if (!t || !add) return undefined;
    if (notify) this.notifiers.set(t.id, notify);
    switch (t.status) {
      case "todo":
      case "queued":
        // Already queued to continue in the original conversation (answer, rework, new message): append to that message, otherwise it won't be seen when it starts
        if (this.resumes.has(t.id)) this.resumes.set(t.id, `${this.resumes.get(t.id)}\n\nAdditional note: ${add}`);
        else this.update(t, { prompt: `${t.prompt}\n\nAdditional note: ${add}` });
        return `Updated the task content of "${t.title}"; it will follow the new instructions when it starts.`;
      case "running":
        if (t.executor || !t.session || !this.backend.steer) return undefined;
        void this.backend.steer(t.session, add).catch((e) => console.warn(`[tasks] Failed to interject: ${(e as Error).message}`));
        return `Interjected this message into the running "${t.title}".`;
      case "blocked":
        this.answer(t.id, add);
        return `Passed this on as an answer to "${t.title}"; it will continue.`;
      default: {
        if (t.executor || !t.session) {
          // Never had a conversation (or done externally): start a new task with the original prompt plus the rework request
          const again = this.start(
            { agent: t.agent, title: t.title, prompt: `${t.prompt}\n\nRework request: ${add}`, doneWhen: t.doneWhen, executor: t.executor, origin: t.origin, reportTo: t.reportTo, chatId: t.chatId },
            notify,
          );
          return `Started a new task to rework "${t.title}" (${again.id}).`;
        }
        this.resumes.set(t.id, `Rework: ${add}`);
        this.update(t, { finished: undefined, result: undefined });
        this.enqueue(t);
        return `"${t.title}" will continue the rework in the original conversation and report again when done.`;
      }
    }
  }

  // ----- internal -----

  /** Can a todo start now: its time has come, and any task it waits on is also done. */
  private ready(t: Task): boolean {
    if (t.hold) return false;
    if (t.when && new Date(t.when) > this.now()) return false;
    if (t.after && this.all.get(t.after)?.status !== "done") return false;
    return true;
  }

  private enqueue(t: Task) {
    this.update(t, { status: "queued" });
    this.waiting.push(t.id);
    this.pump();
  }

  /** Scheduled task is due: start a separate task to run it, and move itself to the next occurrence. */
  private spawnRun(tpl: Task): Task {
    const notify = this.notifiers.get(tpl.id);
    const run = this.start(
      { agent: tpl.agent, title: tpl.title, prompt: tpl.prompt, doneWhen: tpl.doneWhen, executor: tpl.executor, reportTo: tpl.reportTo ?? tpl.origin, chatId: tpl.chatId, parent: tpl.id },
      notify,
    );
    return run;
  }

  /** The alarm went off (or something changed): release due todos, then set the next alarm. */
  private ticking = false;
  private tick() {
    if (this.ticking) return; // releasing tasks calls start()/arm(), don't re-enter
    this.ticking = true;
    try {
      for (const t of [...this.all.values()]) {
        if (t.status !== "todo" || !t.when || !this.ready(t)) continue;
        if (t.repeat) {
          // Move to the next occurrence first, then start this run's task
          const next = nextRun(t.repeat, this.now());
          if (next) this.update(t, { when: iso(next) });
          else this.update(t, { status: "failed", finished: iso(this.now()), result: `Could not parse repeat rule "${t.repeat}"` });
          this.spawnRun(t);
        } else this.enqueue(t);
      }
    } finally {
      this.ticking = false;
    }
    this.arm(false);
  }

  /** Set only one alarm: for the nearest due todo. Wakes at most once an hour (in case time jumps after the computer sleeps). */
  private arm(check = true) {
    if (this.ticking) return;
    if (check) {
      // First check whether anything is already due; if so, release it directly
      const due = this.list((t) => t.status === "todo" && !!t.when && this.ready(t));
      if (due.length) return this.tick();
    }
    clearTimeout(this.timer);
    const times = this.list((t) => t.status === "todo" && !!t.when).map((t) => new Date(t.when!).getTime());
    if (!times.length) return;
    const wait = Math.max(0, Math.min(Math.min(...times) - this.now().getTime(), 3_600_000));
    this.timer = setTimeout(() => this.tick(), wait + 50);
    this.timer.unref?.(); // don't let the alarm keep the process (and tests) from exiting
  }

  /** A task finished: for todos waiting on it, release them if it succeeded, or mark them failed together if it didn't (the "waiting on" is cleared on rerun). */
  private settleDependents(t: Task) {
    for (const d of this.all.values()) {
      if (d.status !== "todo" || d.after !== t.id) continue;
      if (t.status === "done") {
        // Scheduled tasks are started as child tasks by the alarm (tick); don't run the template itself
        if (!d.repeat && this.ready(d)) this.enqueue(d);
      } else {
        this.update(d, { status: "failed", finished: iso(this.now()), result: `The task it was waiting on, "${t.title}", ${STATUS_LABEL[t.status]}, so this one never started.` });
        this.settleDependents(d); // propagate down: tasks waiting on it can't start either
      }
    }
  }

  private pump() {
    const max = this.opts.concurrency ?? 2;
    while (this.running < max && this.waiting.length) {
      const t = this.all.get(this.waiting.shift()!);
      if (!t || t.status !== "queued") continue;
      this.running++;
      const reply = this.resumes.get(t.id);
      this.resumes.delete(t.id);
      if (reply !== undefined) {
        this.update(t, { status: "running" });
        void this.run(t, () => (t.session ? this.backend.send(t.agent, t.session, reply) : Promise.reject(new Error("This task has no conversation to continue in"))));
      } else {
        this.update(t, { status: "running", started: iso(this.now()) });
        void this.run(t);
      }
    }
  }

  /** Run one round: the first time it opens a conversation and hands over the task; when answering a blocked task it continues in the original conversation. */
  private async run(t: Task, step?: () => Promise<string>) {
    let timedOut = false;
    const work =
      step?.() ??
      (async () => {
        if (t.executor) {
          const ex = this.executor(t.executor);
          if (!ex) throw new Error(`No executor named "${t.executor}" (not connected in the Mailroom)`);
          const c = new AbortController();
          this.controllers.set(t.id, c);
          return ex.run(t, c.signal);
        }
        const path = await this.backend.spawn(t.agent, t.title, t.origin);
        if (timedOut || this.stopping.has(t.id)) {
          // Timed out or stopped while opening the conversation (e.g. the original conversation was busy); don't start working; shut down the subprocess if it's already up
          await this.backend.abort?.(path);
          return "";
        }
        this.update(t, { session: path });
        return this.backend.send(t.agent, path, taskPrompt(t));
      })();
    let finished = true;
    try {
      // The timeout counts from dispatching the work, including opening the conversation (forking the original conversation may have to queue behind it)
      const answer = await this.withTimeout(work, () => {
        timedOut = true;
        if (t.executor) void this.stopExecutor(t);
        else if (t.session) void this.backend.abort?.(t.session);
      });
      const q = this.asked.get(t.id);
      this.asked.delete(t.id);
      if (this.stopping.delete(t.id)) this.update(t, { status: "cancelled", finished: iso(this.now()), result: answer || "Stopped." });
      else if (q) {
        finished = false;
        this.update(t, { status: "blocked", question: q, result: answer || undefined });
      } else this.update(t, { status: "done", finished: iso(this.now()), result: answer, question: undefined });
    } catch (e) {
      this.asked.delete(t.id);
      if (this.stopping.delete(t.id)) this.update(t, { status: "cancelled", finished: iso(this.now()), result: "Stopped." });
      else this.update(t, { status: "failed", finished: iso(this.now()), result: (e as Error).message });
    } finally {
      this.controllers.delete(t.id);
      this.running--;
      this.pump(); // Start the next task first, then report back to the original conversation: when it's busy the report has to queue, don't block the whole queue
    }
    if (!finished) return;
    this.notifiers.delete(t.id);
    this.settleDependents(t);
    this.arm();
    await this.announce(t);
  }

  private withTimeout<T>(p: Promise<T>, onTimeout: () => void): Promise<T> {
    const ms = this.opts.timeoutMs;
    if (!ms) return p;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new Error(`Didn't finish within ${Math.round(ms / 60000)} minutes, stopped`));
      }, ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  /** After finishing (or failing), leave a note at the end of the originating conversation so that agent knows next time it answers. */
  private async announce(t: Task) {
    const to = t.reportTo ?? t.origin;
    if (!to) return;
    const head = t.status === "done" ? `✅ Background task "${t.title}" completed` : `❌ Background task "${t.title}" ${STATUS_LABEL[t.status]}`;
    try {
      await this.backend.note(to, `${head} (task ${t.id}):\n\n${t.result ?? ""}`);
    } catch (e) {
      console.warn(`[tasks] Failed to report back to the original conversation: ${(e as Error).message}`);
    }
  }

  private update(t: Task, patch: Partial<Task>) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (t as any)[k];
      else (t as any)[k] = v;
    }
    this.store.save(t);
    this.emit("update", t);
    const n = this.notifiers.get(t.id) ?? this.defaultNotify;
    n?.(t);
  }
}

const iso = (d: Date) => d.toISOString();

function newId() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const r = Math.random().toString(36).slice(2, 5);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${r}`;
}
