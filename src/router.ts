// Router: only does triage and forwarding, never does the work itself.
// First layer (which conversation to route into): decided automatically, see route.ts; can also be specified manually with @botname, /new, /use, /to.
// Second layer (chat or run in background): routing also suggests this; /bg forces background.
import { briefMessage, type HandoffRequest } from "./handoff.js";
import type { Registry, SessionRecord } from "./registry.js";
import { MemoryTaskStore, OPEN, STATUS_LABEL, type Task, Tasks, type TaskStore } from "./tasks.js";
import { taskLine } from "./tasktool.js";
import { buildRouteInput, buildRouteSystem, type Decision, type Part, parseDecision, type RouteCandidate } from "./route.js";
import { MAIN_SESSION } from "./bao.js";
import { roleModel } from "./modelroles.js";
import { BRIEFING } from "./briefing.js";

/** Everything the router needs from the pi layer; can be swapped for a fake in tests. */
export interface AgentBackend {
  listAgents(): string[];
  exists(agent: string): boolean;
  create(agent: string, name: string): Promise<string>;
  /** Fork from an existing conversation (with context) */
  fork(agent: string, fromPath: string, name: string): Promise<string>;
  send(agent: string, path: string, text: string): Promise<string>;
  isBusy(path: string): boolean;
  /** One-shot question to the model (not in a conversation), used for routing */
  complete(system: string, user: string, spec?: string): Promise<string>;
  /** What this bot is responsible for, in one sentence */
  describe(agent: string): string;
  /** The last few things the user said in this conversation (for routing) */
  recent(path: string, n: number): string[];
  /** The chat log of a conversation (for kiki_peek) */
  history?(path: string): { role: "user" | "assistant"; text: string }[];
  /** Create a new bot (when auto-routing finds no suitable bot) */
  createBao?(name: string, duty: string): void;
  /** Append a message to the end of a conversation without triggering a reply (for background task reports) */
  note(agent: string, path: string, text: string): Promise<void>;
  /** Notify the UI that this conversation has a complete reply (optional) */
  announce?(path: string, text: string): void;
  abort?(path: string): Promise<void>;
  /** Insert a message into a running conversation (for revising background tasks, optional) */
  steer?(agent: string, path: string, text: string): Promise<void>;
  /** Background task conversations: open (can fork) and send. If present, use them (each gets its own subprocess); otherwise use create/fork/send (optional) */
  spawnTask?(agent: string, name: string, from?: string): Promise<string>;
  sendTask?(agent: string, path: string, text: string): Promise<string>;
  /** Close a conversation (stop its work, free memory) and move its record to the Trash (optional) */
  discard?(agent: string, path: string, name: string): Promise<void>;
}

type Reply = (text: string) => Promise<void>;

const HELP = `I'm Kiki. Just talk to me and I'll figure out which conversation to route into, or start a new one.
@botname <message>       Send to a specific bot
/to <bot/conversation | bot name> The last message went to the wrong place, redirect it
/new <agent> <name>  Start a new conversation and switch to it
/use <name>          Switch to an existing conversation (use agent/name if ambiguous)
/list [agent]        See which conversations exist
/bg <task>           Start a new background conversation to do it, report back here when done
/tasks [all]         See background tasks (by default only unfinished ones and the last 10)
/retry <task id>     Re-run a failed or interrupted task
/run <task id>       Start a todo now (for scheduled tasks, run one extra time now)
/cancel <task id>    Cancel a todo, scheduled task, or a task waiting on your answer
/answer <task id> <message> Answer a stuck task (you can also just reply in that background conversation)
/stop <task id>      Stop a task (works even if it's running)
/revise <task id> <message> Revise a task: change the content if not started, insert a message if running, rework in the original conversation if done
/agents              See which agents exist
/where               Where am I right now`;

export class Router {
  readonly tasks: Tasks;
  private reserved = new Set<string>(); // conversation names being created (bot/name), prevents duplicates during handoff
  private creating = new Map<string, Promise<SessionRecord>>(); // conversations being created (bot/name), prevents concurrent duplicate creation
  /** Routing rules (user-editable Markdown), read fresh on every route, no restart needed after edits. main.ts wires this to ~/Kiki/routing-rules.md. */
  rules: () => string = () => "Once you've decided, just do it and tell the user when done.";
  /** Feature toggles from the settings page (features.ts), wired in main.ts; all on by default. */
  isOn: (id: "route" | "background") => boolean = () => true;
  /** Kiki's routing progress (thinking about who to hand off to / handed off to which conversation), used by the web UI to show "working"; wired in server.ts. */
  progress: (chatId: string, p: { status: string; path?: string }) => void = () => {};

  constructor(
    private agents: AgentBackend,
    private registry: Registry,
    private defaultAgent: string,
    store: TaskStore = new MemoryTaskStore(),
    taskOpts: { concurrency?: number; timeoutMs?: number } = {},
  ) {
    this.tasks = new Tasks(
      store,
      {
        // If there's an original conversation, fork it (the background can see what was discussed before); otherwise start a new one
        spawn: async (agent, title, from) => {
          let name = `bg-${title}`;
          for (let i = 2; this.registry.get(agent, name); i++) name = `bg-${title}${i}`;
          if (!this.agents.spawnTask) return (from ? await this.forkSession(agent, from, name) : await this.newSession(agent, name, true)).path;
          // One subprocess per task: open the conversation inside the subprocess, only record it in the registry here
          const path = await this.agents.spawnTask(agent, name, from);
          this.registry.add({ agent, name, path, created: new Date().toISOString(), background: true });
          return path;
        },
        send: (agent, path, text) => (this.agents.sendTask ? this.agents.sendTask(agent, path, text) : this.agents.send(agent, path, text)),
        abort: this.agents.abort ? (path) => this.agents.abort!(path) : undefined,
        steer: this.agents.steer
          ? async (path, text) => {
              const rec = this.registry.byPath(path);
              if (rec) await this.agents.steer!(rec.agent, path, text);
            }
          : undefined,
        note: async (path, text) => {
          const rec = this.registry.byPath(path);
          if (rec) await this.agents.note(rec.agent, path, text);
        },
      },
      taskOpts,
    );
  }

  private locks = new Map<string, Promise<void>>(); // messages in the same chat are routed in order

  async handle(chatId: string, text: string, reply: Reply): Promise<void> {
    const t = text.trim();
    if (!t.startsWith("/")) {
      // Routing waits on the model, and the user may send another message meanwhile; queue so earlier messages enter the conversation first and later ones can see where the earlier one went.
      // The lock only lasts until "the message is queued into the conversation", not until the reply, so different conversations don't slow each other down.
      const prev = this.locks.get(chatId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const mine = prev.then(() => gate);
      this.locks.set(chatId, mine);
      await prev;
      try {
        return await this.chat(chatId, t, reply, release);
      } finally {
        release();
        if (this.locks.get(chatId) === mine) this.locks.delete(chatId);
      }
    }

    const [cmdRaw, ...args] = t.split(/\s+/);
    const cmd = cmdRaw;
    switch (cmd) {
      case "/start":
      case "/help":
        return reply(HELP);
      case "/agents":
        return reply(`agents: ${this.agents.listAgents().join(", ") || "(none yet, create a folder under agents/ in the data folder)"}`);
      case "/where": {
        const cur = this.registry.current(chatId);
        return reply(cur ? `Current: ${label(cur)}` : "No conversation selected yet; just talk and it'll go to the default conversation.");
      }
      case "/new":
        return this.cmdNew(chatId, args, reply);
      case "/use":
        return this.cmdUse(chatId, args.join(" "), reply);
      case "/list":
        return this.cmdList(chatId, args[0], reply);
      case "/to":
        return this.cmdTo(chatId, args, reply);
      case "/bg":
        return this.cmdBg(chatId, t.slice(cmdRaw.length).trim(), reply);
      case "/tasks":
        return this.cmdTasks(args[0] === "all", reply);
      case "/retry": {
        const old = this.tasks.get(args[0] ?? "");
        if (!old) return reply("Usage: /retry <task id>, see /tasks for ids.");
        const t = this.tasks.retry(old.id, this.notifier(reply));
        return reply(t ? `OK, starting over: "${t.title}" (task ${t.id})` : "This task hasn't finished, no need to re-run.");
      }
      case "/run": {
        const t = this.tasks.runNow(args[0] ?? "", this.notifier(reply));
        return reply(t ? `OK, "${t.title}" starts now.` : "Usage: /run <todo task id>, see /tasks for ids.");
      }
      case "/cancel": {
        const t = this.tasks.cancel(args[0] ?? "");
        return reply(t ? `Cancelled "${t.title}".` : "Usage: /cancel <task id> (a todo, scheduled, queued, or waiting-on-you task).");
      }
      case "/stop": {
        const t = await this.tasks.stop(args[0] ?? "");
        return reply(t ? (t.status === "running" ? `Stopping "${t.title}"…` : `Stopped "${t.title}".`) : "Usage: /stop <task id>, see /tasks for ids.");
      }
      case "/revise": {
        if (!args[1]) return reply("Usage: /revise <task id> <what to change>");
        return reply(this.tasks.revise(args[0], args.slice(1).join(" "), this.notifier(reply)) ?? "This task can't be revised right now (no such task, or an external bot is working on it).");
      }
      case "/answer": {
        if (!args[1]) return reply("Usage: /answer <task id> <your answer>");
        const t = this.tasks.answer(args[0], args.slice(1).join(" "), this.notifier(reply));
        return reply(t ? `Got it, "${t.title}" continues.` : "This task isn't waiting on your answer.");
      }
      default:
        return reply(`I don't know ${cmd}.\n\n${HELP}`);
    }
  }

  private last = new Map<string, string>(); // the last routed message per chat, used by /to to redirect

  private async chat(chatId: string, text: string, reply: Reply, release: () => void = () => {}) {
    // Starts with @botname: only choose within that bot
    let onlyAgent: string | undefined;
    const at = text.match(/^@(\S+)\s+([\s\S]+)$/);
    if (at && this.agents.exists(at[1])) {
      onlyAgent = at[1];
      text = at[2].trim();
    }
    // No multiple choice: the model picks the best place itself; if it's wrong, use /to to redirect
    this.progress(chatId, { status: "Thinking about which bot to hand this to…" });
    const d = await this.decide(chatId, text, onlyAgent);
    return this.deliver(chatId, text, d, reply, release);
  }

  /** Let a cheap model decide where it goes; if the model is unavailable or answers nonsense, fall back to "current conversation / default conversation". */
  private async decide(chatId: string, text: string, onlyAgent?: string): Promise<Decision> {
    await this.ensureMains();
    const cur = this.registry.current(chatId);
    const fallback = (): Decision => {
      if (cur && (!onlyAgent || cur.agent === onlyAgent)) return { action: "continue", target: label(cur), mode: "chat" };
      const agent = onlyAgent ?? this.defaultAgent;
      return { action: "new", agent, name: MAIN_SESSION, mode: "chat" }; // hand to that bot's main chat
    };
    if (!this.isOn("route")) return fallback(); // auto-routing off: go to the current conversation or the default bot
    const agents = this.agents.listAgents();
    const candidates: RouteCandidate[] = agents.map((agent) => {
      // Per bot: main chat + current conversation + a few recently active threads, one summary line each
      const all = this.registry.list(agent);
      const recent = new Set(byActivity(all.filter((s) => s.name !== MAIN_SESSION)).slice(0, ROUTE_THREADS));
      const shown = all.filter((s) => s.name === MAIN_SESSION || s.path === cur?.path || recent.has(s));
      return {
        agent,
        desc: this.agents.describe(agent),
        sessions: shown.map((s) => ({
          label: label(s),
          summary: s.summary,
          recent: s.summary ? [] : this.agents.recent(s.path, 1),
          background: s.background,
        })),
        more: all.length - shown.length,
      };
    });
    const targets = candidates.flatMap((c) => c.sessions.map((s) => s.label));
    // Show background tasks to the router too: unfinished ones + the last 5 finished, so it can recognize "revise that task"
    const all = this.tasks.list((t) => !t.repeat || t.status === "todo");
    const tasks = [...all.filter((t) => OPEN.includes(t.status)), ...all.filter((t) => !OPEN.includes(t.status)).slice(-5)]
      .filter((t) => !onlyAgent || t.agent === onlyAgent)
      .map((t) => ({ id: t.id, title: t.title, agent: t.agent, status: t.repeat ? `scheduled ${t.repeat}` : STATUS_LABEL[t.status] }));
    try {
      const raw = await this.agents.complete(
        buildRouteSystem(this.rules()),
        buildRouteInput({ text, candidates, current: cur ? label(cur) : undefined, onlyAgent, now: nowText(), tasks }),
        roleModel("route"), // models configured by role: falls back to the default model if unset
      );
      const d = parseDecision(raw, {
        agents: onlyAgent ? [onlyAgent] : agents,
        targets: onlyAgent ? targets.filter((t) => t.startsWith(`${onlyAgent}/`)) : targets,
        allowNewBao: !onlyAgent && !!this.agents.createBao, // if the user @'d a bot, only choose within it
        allowReply: !onlyAgent,
        tasks: tasks.map((t) => t.id),
      });
      if (d) return d;
      console.warn("[route] couldn't parse model output, using default destination:", raw.slice(0, 200));
    } catch (e) {
      console.warn("[route] routing model error, using default destination:", (e as Error).message);
    }
    return fallback();
  }

  /** Send this message into the conversation per the decision, returning the ack + reply together to the user. */
  private async deliver(chatId: string, text: string, d: Decision, reply: Reply, release: () => void = () => {}) {
    this.last.set(chatId, text);
    if (d.action === "reply") {
      release();
      return reply(`Kiki · direct answer\n\n${d.text}`);
    }
    if (d.action === "split") return this.deliverSplit(chatId, d.parts, reply, release);
    if (d.action === "task") {
      release();
      const t = this.tasks.get(d.id)!;
      const how = this.tasks.revise(d.id, d.text, this.notifier(reply));
      const where = t.session ? this.registry.byPath(t.session) : undefined;
      return reply(`→ background task "${t.title}"${where ? ` (${link(where)})` : ""}\n\n${how ?? "This task can't be revised right now, I'll treat it as a new task: /bg " + d.text}`);
    }
    let made = "";
    if (d.action === "new" && d.newBao && !this.agents.exists(d.agent)) {
      try {
        this.agents.createBao!(d.agent, d.newBao);
        made = `created bot "${d.agent}", `;
      } catch (e) {
        console.warn("[route] failed to create bot, using the default bot:", (e as Error).message);
        d = { ...d, agent: this.defaultAgent, newBao: undefined };
      }
    }
    if (d.mode === "background" && !this.isOn("background")) d = { ...d, mode: "chat", taskTitle: undefined };
    if (d.mode === "background") {
      // Work dispatched from an existing conversation: fork that conversation into the background (carrying the earlier discussion), and report the result back to it;
      // a new topic starts a task directly, without opening another empty conversation
      const hit = d.action === "continue" ? this.registry.find(d.target)[0] : undefined;
      const origin = hit?.name === MAIN_SESSION ? undefined : hit; // work handed to the bot's main chat doesn't fork the main chat; start a clean task
      const agent = hit?.agent ?? (d.action === "new" ? d.agent : this.defaultAgent);
      const title = d.taskTitle ?? (d.action === "new" && d.name !== MAIN_SESSION ? d.name : stamp());
      release();
      return this.runBackground(chatId, agent, text, title, origin, reply, d.doneWhen);
    }
    let rec: SessionRecord;
    let how: string;
    if (d.action === "continue") {
      rec = this.registry.find(d.target)[0];
      how = rec.name === MAIN_SESSION ? "handed to bot" : "continued";
    } else {
      if (d.name === MAIN_SESSION) {
        rec = await this.ensureMain(d.agent);
        how = made ? "created bot" : "handed to bot";
      } else {
        let name = d.name;
        for (let i = 2; this.registry.get(d.agent, name); i++) name = `${d.name}${i}`; // avoid duplicate names
        rec = await this.newSession(d.agent, name);
        how = made ? "created bot and opened" : "opened";
      }
    }
    this.registry.setCurrent(chatId, rec.path);
    const busy = this.agents.isBusy(rec.path) ? ", still working on something, queued" : ""; // that conversation is busy: tell the user it's queued
    this.progress(chatId, { status: `Handed to ${label(rec)}${busy}`, path: rec.path });
    const pending = this.agents.send(rec.agent, rec.path, text); // already queued in the conversation
    release();
    const answer = await pending;
    await reply(`→ ${label(rec)} · ${how}\n\n${answer}`);
  }

  /** One message split into several items: create the bots and conversations for each (in order, to avoid name clashes), then dispatch them all at once; Kiki immediately replies with a list, one card per item.
   *  Each part's answer appears directly in its own conversation; we don't wait for them to finish. */
  private async deliverSplit(chatId: string, parts: Part[], reply: Reply, release: () => void) {
    const lines: string[] = [];
    const jobs: (() => void)[] = [];
    let first: SessionRecord | undefined;
    for (const p of parts) {
      let agent = p.action === "continue" ? this.registry.find(p.target)[0]?.agent ?? this.defaultAgent : p.agent;
      let made = "";
      if (p.action === "new" && p.newBao && !this.agents.exists(agent)) {
        try {
          this.agents.createBao!(agent, p.newBao);
          made = "created bot";
        } catch (e) {
          console.warn("[route] failed to create bot, using the default bot:", (e as Error).message);
          agent = this.defaultAgent;
        }
      }
      const origin = p.action === "continue" ? this.registry.find(p.target)[0] : undefined;
      if (p.mode === "background" && this.isOn("background")) {
        const title = p.taskTitle ?? (p.action === "new" && p.name !== MAIN_SESSION ? p.name : stamp());
        const fork = origin?.name === MAIN_SESSION ? undefined : origin; // the main chat isn't forked; background tasks start from a clean context
        this.tasks.start({ agent, title, prompt: p.text, doneWhen: p.doneWhen, origin: fork?.path, chatId }, this.notifier(reply));
        lines.push(`- Background task "${title}" (${agent}): ${made ? "created bot, " : ""}will report back here when done`);
        continue;
      }
      let rec: SessionRecord;
      if (origin) rec = origin;
      else if (p.action === "new" && p.name === MAIN_SESSION) rec = await this.ensureMain(agent);
      else {
        const base = p.action === "new" ? p.name : stamp();
        let name = base;
        for (let i = 2; this.registry.get(agent, name); i++) name = `${base}${i}`;
        rec = await this.newSession(agent, name);
      }
      first ??= rec;
      lines.push(`- ${link(rec)}: ${made || (rec.name === MAIN_SESSION ? "handed to bot" : origin ? "continued" : "opened")}`);
      jobs.push(() =>
        this.agents
          .send(rec.agent, rec.path, p.text)
          .then((r) => this.agents.announce?.(rec.path, r))
          .catch((e) => this.agents.announce?.(rec.path, `Something went wrong: ${(e as Error).message}`)),
      );
    }
    if (first) {
      this.registry.setCurrent(chatId, first.path);
      this.progress(chatId, { status: `Split into ${parts.length} items`, path: first.path });
    }
    for (const run of jobs) run(); // queue into each conversation
    release();
    await reply(`Kiki · split into ${parts.length} items, dispatched separately\n\n${lines.join("\n")}`);
  }

  /** /to: the previous message was routed wrong; send it somewhere else. The argument is "bot/conversation name", or "bot new-conversation-name". */
  private async cmdTo(chatId: string, args: string[], reply: Reply) {
    const text = this.last.get(chatId);
    if (!text) return reply("There's no message to reroute yet.");
    if (args.length === 0) return reply("Usage: /to bot/conversation-name, or /to bot new-conversation-name");
    if (args[0].includes("/")) {
      const hits = this.registry.find(args.join(" "));
      if (hits.length !== 1) return reply(hits.length ? "Duplicate names; please write the full bot/conversation name." : `Couldn't find "${args.join(" ")}".`);
      return this.deliver(chatId, text, { action: "continue", target: label(hits[0]), mode: "chat" }, reply);
    }
    const [agent, ...rest] = args;
    if (!this.agents.exists(agent)) return reply(`There's no bot "${agent}".`);
    return this.deliver(chatId, text, { action: "new", agent, name: rest.join(" ") || stamp(), mode: "chat" }, reply);
  }

  private async cmdNew(chatId: string, args: string[], reply: Reply) {
    const [agent, ...nameParts] = args;
    if (!agent) return reply("Usage: /new <agent> <name>, e.g. /new Kiki weekly-report");
    if (!this.agents.exists(agent)) return reply(`There's no agent "${agent}". Existing: ${this.agents.listAgents().join(", ")}`);
    const name = nameParts.join(" ") || stamp();
    if (this.registry.get(agent, name)) return reply(`${agent}/${name} already exists; use /use ${agent}/${name} to switch to it.`);
    const rec = await this.newSession(agent, name);
    this.registry.setCurrent(chatId, rec.path);
    return reply(`Created and switched to ${label(rec)}`);
  }

  private async cmdUse(chatId: string, query: string, reply: Reply) {
    if (!query) return reply("Usage: /use <name> or /use <agent>/<name>");
    const hits = this.registry.find(query);
    if (hits.length === 0) return reply(`Couldn't find "${query}"; use /list to see what's available.`);
    if (hits.length > 1) return reply(`Duplicate names: ${hits.map(label).join(", ")}; please write agent/name.`);
    this.registry.setCurrent(chatId, hits[0].path);
    return reply(`Switched to ${label(hits[0])}`);
  }

  private async cmdList(chatId: string, agent: string | undefined, reply: Reply) {
    const all = this.registry.list(agent);
    if (all.length === 0) return reply("No conversations yet.");
    const cur = this.registry.current(chatId)?.path;
    const lines = all.map((s) => {
      const marks = [s.path === cur ? "👉" : "  ", this.agents.isBusy(s.path) ? "⏳" : "", s.background ? "[background]" : ""];
      return `${marks.join("")} ${label(s)}`;
    });
    return reply(lines.join("\n"));
  }

  /** /bg: force background. Dispatched from the current conversation, and the result is reported back to it. */
  private async cmdBg(chatId: string, task: string, reply: Reply) {
    if (!task) return reply("Usage: /bg <task>");
    const cur = this.registry.current(chatId);
    const title = task.replace(/\s+/g, " ").slice(0, 16);
    return this.runBackground(chatId, cur?.agent ?? this.defaultAgent, task, title, cur, reply);
  }

  /** The single entry point for background execution (/bg and auto-routing to background both go through here); see tasks.ts for details. */
  private async runBackground(chatId: string, agent: string, task: string, title: string, origin: SessionRecord | undefined, reply: Reply, doneWhen?: string) {
    const t = this.tasks.start({ agent, title, prompt: task, doneWhen, origin: origin?.path, chatId }, this.notifier(reply));
    const wait = t.status === "queued" ? ", another task is still running, queued" : "";
    await reply(`→ ${agent} · Background task "${title}"\n\nOkay, handed to the background${wait}; I'll report back when it's done${origin ? ` here and in ${label(origin)}` : ""}. Use /tasks to check progress.`);
  }

  /** Report back to the originating chat (inbox) when a task finishes, fails, or gets stuck. */
  private notifier(reply: Reply) {
    return (t: Task) => {
      const msg = this.notice(t);
      if (msg) void reply(msg);
    };
  }

  /** One line for the inbox when a task's status changes; returns undefined when there's nothing to say. The server also uses it to report tasks started on a schedule. */
  notice(t: Task): string | undefined {
    const where = t.session ? this.registry.byPath(t.session) : undefined;
    const tag = where ? ` (${link(where)})` : "";
    if (t.executor === BRIEFING && t.status === "done") return t.result; // daily briefing: the body is exactly what to say
    if (t.status === "done") return `✅ Background task "${t.title}" finished${tag}:\n\n${t.result}`;
    if (t.status === "failed") return `❌ Background task "${t.title}" failed${tag}: ${t.result}\nTo retry: /retry ${t.id}`;
    if (t.status === "cancelled" && t.started) return `⏹ Background task "${t.title}" stopped${tag}.`;
    if (t.status === "blocked")
      return `⏸ Background task "${t.title}" is missing something and is waiting on you${tag}:\n\n${t.question}\n\nJust reply in that conversation, or /answer ${t.id} your answer.`;
    return undefined;
  }

  /** One line for the bot's main chat: how many background tasks are running, waiting on you, or to do. Returns an empty string if none. */
  taskCount(agent?: string): string {
    const mine = this.tasks.list((t) => (!agent || t.agent === agent) && OPEN.includes(t.status));
    if (!mine.length) return "";
    const n = (f: (t: Task) => boolean) => mine.filter(f).length;
    const parts = [
      ["running", n((t) => t.status === "running" || t.status === "queued")],
      ["waiting on user", n((t) => t.status === "blocked")],
      ["to do and scheduled", n((t) => t.status === "todo")],
    ].filter(([, c]) => c) as [string, number][];
    return `Background tasks: ${parts.map(([k, c]) => `${k} ${c}`).join(", ")} (kiki_task action=list for details, stop to stop, revise to change or redo)`;
  }

  private async cmdTasks(all: boolean, reply: Reply) {
    let list = this.tasks.list();
    if (!all) {
      const open = list.filter((t) => OPEN.includes(t.status));
      const recent = list.filter((t) => !open.includes(t)).slice(-10);
      list = [...open, ...recent];
    }
    if (list.length === 0) return reply("No background tasks yet.");
    return reply(list.map((t) => taskLine(t)).join("\n"));
  }

  /** Handoff: goes through here when an agent in a conversation calls kiki_handoff. The new conversation's first message is the handoff brief.
   *  Doesn't wait for the new conversation to answer (the tool call is still stuck in the original conversation; waiting would hold it up). */
  async handoff(req: HandoffRequest): Promise<string> {
    let made = "";
    if (!this.agents.exists(req.bao)) {
      if (!req.duty?.trim() || !this.agents.createBao)
        throw new Error(`There's no bot "${req.bao}". Existing: ${this.agents.listAgents().join(", ")}; to create one, also fill in duty (what this bot is responsible for)`);
      this.agents.createBao(req.bao, req.duty);
      await this.ensureMain(req.bao);
      made = `created bot "${req.bao}", `;
    }
    const base = req.name.replace(/[\/\n]/g, " ").trim().slice(0, 30) || stamp();
    if (req.mode === "background" && !this.isOn("background")) req = { ...req, mode: "chat" }; // if background tasks are off, open a normal conversation
    const from = req.fromPath ? this.registry.byPath(req.fromPath) : undefined;
    const msg = briefMessage(from ? label(from) : undefined, req.brief, req.mode);

    if (req.mode === "background") {
      // background: start a clean new conversation from the handoff brief (don't fork the original; only carry the context in the brief), and report back to the original when done
      // reportTo: report only, no fork; stored in the task file, so /retry after a restart also reports back to the original conversation
      this.tasks.start({ agent: req.bao, title: base, prompt: msg, reportTo: from?.path, chatId: "handoff" });
      return `${made}handed to background task "${base}" (${req.bao}); it will report back to this conversation when done.`;
    }

    // Reserve the name synchronously before creating the conversation: two conversations handing off the same name at once won't collide
    let name = base;
    for (let i = 2; this.registry.get(req.bao, name) || this.reserved.has(`${req.bao}/${name}`); i++) name = `${base}${i}`;
    const key = `${req.bao}/${name}`;
    this.reserved.add(key);
    let rec: SessionRecord;
    try {
      rec = await this.newSession(req.bao, name);
    } finally {
      this.reserved.delete(key);
    }
    this.agents
      .send(rec.agent, rec.path, msg)
      .then((r) => this.agents.announce?.(rec.path, r))
      .catch((e) => this.agents.announce?.(rec.path, `Something went wrong: ${(e as Error).message}`));
    return `${made}handed off to ${label(rec)}; the new conversation has received the handoff brief. When telling the user, write the conversation as ${link(rec)} so it becomes a clickable card in the UI.`;
  }

  /** Delete a thread: stop it, remove it from the registry, and move its records to the Trash. A bot's main chat can't be deleted, only cleared. */
  async deleteSession(path: string): Promise<SessionRecord> {
    const rec = this.registry.byPath(path);
    if (!rec) throw new Error("No such conversation");
    if (rec.name === MAIN_SESSION) throw new Error("A bot's main chat can't be deleted, but it can be cleared");
    this.registry.remove(path);
    await this.agents.discard?.(rec.agent, path, rec.name);
    return rec;
  }

  /** Clear a bot's main chat: move the old records to the Trash, swap in a new empty conversation, keeping the same name and location. The returned record already points to the new file. */
async clearMain(path: string): Promise<SessionRecord> {
    const rec = this.registry.byPath(path);
    if (!rec) throw new Error("No such conversation");
    if (rec.name !== MAIN_SESSION) throw new Error("Only the main chat can be cleared; delete threads directly");
    const fresh = await this.agents.create(rec.agent, MAIN_SESSION);
    this.registry.repoint(path, fresh);
    await this.agents.discard?.(rec.agent, path, rec.name);
    return rec;
  }

  /** A bot's main chat: create it if it doesn't exist. */
  async ensureMain(agent: string): Promise<SessionRecord> {
    return this.registry.get(agent, MAIN_SESSION) ?? (await this.newSession(agent, MAIN_SESSION));
  }

  /** Give every bot a main chat (called at startup and before routing; all conversations in old data are treated as threads). */
  async ensureMains() {
    for (const a of this.agents.listAgents()) if (!this.registry.get(a, MAIN_SESSION)) await this.ensureMain(a);
  }

  /** Find a conversation: bot name/conversation name. */
  private resolve(target: string): SessionRecord {
    const t = target.trim().replace(/^\//, "");
    const i = t.indexOf("/");
    const rec = i > 0 ? this.registry.get(t.slice(0, i), t.slice(i + 1)) : this.registry.get(t, MAIN_SESSION); // bot name only = that bot's main chat
    if (rec) return rec;
    const hits = this.registry.find(t);
    if (hits.length === 1) return hits[0];
    const all = this.registry.list().map(label);
    throw new Error(`Conversation "${target}" not found. Existing: ${all.slice(-30).join(", ") || "(none)"}`);
  }

  /** The thread list a bot's main chat sees each turn: one summary line per thread, most recently active first. Returns empty if there are no threads. */
  threadDigest(agent: string): string {
    const ss = byActivity(this.registry.list(agent).filter((s) => s.name !== MAIN_SESSION));
    if (!ss.length) return "";
    const lines = ss.slice(0, DIGEST_THREADS).map((s) => {
      const tags = [this.agents.isBusy(s.path) ? "running" : "", s.background ? "background" : ""].filter(Boolean).join(", ");
      const about = s.summary ?? this.agents.recent(s.path, 1)[0] ?? "no content yet";
      return `- [${s.name}](kiki:${agent}/${s.name})${tags ? ` [${tags}]` : ""}: ${about}`;
    });
    if (ss.length > DIGEST_THREADS) lines.push(`- (${ss.length - DIGEST_THREADS} older threads not shown; use kiki_peek to view them)`);
    return `## This bot's current threads (updated every turn, most recently active first)
If what the user says clearly continues one of these threads, use kiki_relay to hand it to that thread (target is "${agent}/conversation-name"); for details use kiki_peek to read that thread's original text; if it's something new, answer it yourself or use kiki_handoff to start a new thread.
${lines.join("\n")}`;
  }

  /** kiki_peek: without a target, list all conversations; with one, return that thread's most recent n messages. */
  peek(target: string | undefined, n: number): string {
    if (!target) {
      const lines: string[] = [];
      for (const a of this.agents.listAgents()) {
        const desc = this.agents.describe(a);
        lines.push(`## ${a}${desc ? ` (${desc})` : ""}`);
        const ss = this.registry.list(a);
        if (!ss.length) lines.push("(no conversations yet)");
        for (const s of ss.slice(-20)) {
          const tags = [this.agents.isBusy(s.path) ? "running" : "", s.background ? "background" : ""].filter(Boolean).join(", ");
          const about = s.summary ?? (this.agents.recent(s.path, 1)[0] ? `latest "${this.agents.recent(s.path, 1)[0]}"` : "");
          lines.push(`- ${label(s)}${tags ? ` [${tags}]` : ""}${about ? `: ${about}` : ""}`);
        }
      }
      return lines.join("\n");
    }
    const rec = this.resolve(target);
    const h = this.agents.history?.(rec.path) ?? [];
    if (!h.length) return `${label(rec)} has no messages yet.`;
    const busy = this.agents.isBusy(rec.path) ? " (running)" : "";
    const body = h
      .slice(-n)
      .map((l) => `${l.role === "user" ? "User" : "Assistant"}: ${l.text.length > 800 ? `${l.text.slice(0, 800)}…` : l.text}`)
      .join("\n\n");
    return `${label(rec)}${busy} most recent ${Math.min(n, h.length)} of ${h.length} messages:\n\n${body}`;
  }

  /** kiki_relay: pass a message to another conversation; when it replies, record the reply back in the originating conversation. Returns an ack immediately. */
  async relay(fromPath: string | undefined, target: string, text: string): Promise<string> {
    const to = this.resolve(target);
    if (to.path === fromPath) throw new Error("That's the current conversation; no need to relay");
    const from = fromPath ? this.registry.byPath(fromPath) : undefined;
    const msg = `[Message relayed${from ? ` from "${label(from)}"` : ""}]\n${text.trim()}`;
    this.agents
      .send(to.agent, to.path, `${msg}\n\n(The above was relayed from another conversation. When done, reply with a few sentences summarizing the conclusion.)`)
      .then(async (r) => {
        this.agents.announce?.(to.path, r);
        if (from) await this.agents.note(from.agent, from.path, `[Reply from ${label(to)}]\n${r}`);
      })
      .catch(async (e) => {
        if (from) await this.agents.note(from.agent, from.path, `[Error in ${label(to)}] ${(e as Error).message}`).catch(() => {});
      });
    return `Relayed to ${label(to)}; its reply will be recorded back in this conversation. When telling the user, write the conversation as ${link(to)}.`;
  }

  private async forkSession(agent: string, fromPath: string, name: string): Promise<SessionRecord> {
    const path = await this.agents.fork(agent, fromPath, name);
    const rec: SessionRecord = { agent, name, path, created: new Date().toISOString(), background: true };
    this.registry.add(rec);
    return rec;
  }

  async newSession(agent: string, name: string, background = false): Promise<SessionRecord> {
    const existing = this.registry.get(agent, name);
    if (existing) return existing;
    // If one with the same name is being created, wait for it, so concurrency doesn't create two conversations with the same name (e.g. startup main-chat creation colliding with the first message)
    const key = `${agent}/${name}`;
    const busy = this.creating.get(key);
    if (busy) return busy;
    const run = (async () => {
      const path = await this.agents.create(agent, name);
      const rec: SessionRecord = { agent, name, path, created: new Date().toISOString(), background: background || undefined };
      this.registry.add(rec);
      return rec;
    })();
    this.creating.set(key, run);
    try {
      return await run;
    } finally {
      this.creating.delete(key);
    }
  }
}

/** How many recent threads to list per bot when Kiki routes (summaries only); how many the main chat sees each turn */
const ROUTE_THREADS = 5;
const DIGEST_THREADS = 30;

/** Sort by most recent activity (never-replied ones by creation time), newest first */
function byActivity(ss: SessionRecord[]): SessionRecord[] {
  return [...ss].sort((a, b) => (b.active ?? b.created).localeCompare(a.active ?? a.created));
}

/** Local time and time zone, e.g. "11/2/2026, 06:15 Monday (Asia/Shanghai)" */
function nowText(d = new Date()) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const t = d.toLocaleString("en-US", { hour12: false, year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", weekday: "long" });
  return `${t} (${tz})`;
}

const label = (s: SessionRecord) => `${s.agent}/${s.name}`;
/** Conversation reference: the web UI renders [name](kiki:bot/conversation) as a clickable card that opens that conversation in the right column. */
const link = (s: SessionRecord) => `[${s.name === MAIN_SESSION ? s.agent : s.name}](kiki:${label(s)})`; // the main chat's card shows the bot name

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
