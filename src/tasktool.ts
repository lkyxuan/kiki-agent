// Task tools: the agent in a conversation can record to-dos, scheduled tasks, "wait for A to finish, then do B"; when a background task gets stuck it can stop and ask the user.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { nextRun, parseWhen, showTime } from "./schedule.js";
import { OPEN, STATUS_LABEL, type Task, type Tasks } from "./tasks.js";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], details: undefined, ...(isError ? { isError } : {}) }) as any;

/** One-line task description: for the agent and the user. */
export function taskLine(t: Task, now = new Date()): string {
  const when = t.repeat ? `${t.repeat}, next ${t.when ? showTime(t.when, now) : "?"}` : t.when && t.status === "todo" ? `starts ${showTime(t.when, now)}` : "";
  const extra = [when, t.after && t.status === "todo" ? `after task ${t.after}` : ""].filter(Boolean).join(", ");
  return `[${t.repeat ? "scheduled" : STATUS_LABEL[t.status]}] ${t.title} · ${t.agent}${extra ? ` · ${extra}` : ""} · ${t.id}`;
}

/** Watchlist (managed by the Mailroom, one per bot, under agents/<bot>/): things to keep an eye on after a task is done; written to the watchlist of the bot the task belongs to. When relevant new messages arrive, the Mailroom calls tasks.followUp(taskId, message). */
export interface WatchList {
  add(w: { taskId: string; title: string; about: string; match: string; until?: string; agent: string; session?: string }): Promise<string> | string;
  remove(taskId: string, agent: string): Promise<void> | void;
}

export function taskTools(opts: {
  tasks: Tasks;
  /** The Mailroom's watchlist; when not connected, kiki_watch will say so */
  watch?: () => WatchList | undefined;
  listBaos: () => string[];
  /** Which bot this conversation belongs to (used when no bot is given) */
  baoOf: (sessionPath: string | undefined) => string | undefined;
  now?: () => Date;
}): ToolDefinition[] {
  const now = () => opts.now?.() ?? new Date();

  const task: ToolDefinition = {
    name: "kiki_task",
    label: "Record task",
    description:
      "Manage background tasks. action=add: record something to do in the background — set when to do it at that time, set repeat to repeat on schedule (scheduled task), set after to wait for that task to finish first, or leave all empty to start right away; hold=true only records it as a to-do and waits for the user to press start." +
      "action=list: view tasks (unfinished + recently finished). action=stop: stop a task (running ones can be stopped too; fill in id)." +
      "action=revise: revise a task (fill in id and text) — for a task that hasn't started, improve its content; for a running one, interject into it; for one waiting on you, treat it as the answer; for a finished one, redo it in the original conversation and report again when done." +
      "done_when: one sentence on what counts as done (completion criteria); execution will check against it." +
      "when formats: +30m, +2h, +1d, 21:00 (today, or tomorrow if past), tomorrow 09:00, day after tomorrow 9:30, Friday 18:00, next Monday 10:00, 2026-11-05 09:00." +
      "repeat formats: every day 09:00, weekdays 09:00, every Monday 09:00, every hour.",
    promptSnippet: "kiki_task: record to-dos, scheduled tasks (daily/weekly), and things to do after some task finishes",
    promptGuidelines: [
      "When the user says \"tomorrow / at what time / every day / every week… do … for me\", \"after … is done, then …\", \"note it down for later\", use kiki_task to record it — don't just agree verbally; after recording, tell the user in one sentence when it will be done and where the result will be reported.",
      "prompt should be written as a complete task that can be acted on directly when the time comes (with its own context), because execution happens in a new background conversation that can't see the chat here.",
      "When adding, fill in done_when (what counts as done) as much as possible so the result has clear boundaries.",
      "When the user wants to stop, revise, or redo a task: first action=list to find the id, then use stop or revise (write text as one sentence to that task); to change the time, stop the old one and add a new one.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union([Type.Literal("add"), Type.Literal("list"), Type.Literal("stop"), Type.Literal("revise"), Type.Literal("cancel")], { description: "defaults to add; cancel is the same as stop" }),
      ),
      title: Type.Optional(Type.String({ description: "Task name, within 10 characters" })),
      prompt: Type.Optional(Type.String({ description: "Complete task instructions to hand to the background conversation when the time comes" })),
      bao: Type.Optional(Type.String({ description: "Which bot should do it; defaults to this bot" })),
      when: Type.Optional(Type.String({ description: "When to do it (one-off)" })),
      repeat: Type.Optional(Type.String({ description: "Repeat rule (scheduled task)" })),
      after: Type.Optional(Type.String({ description: "Wait for this task id to finish first" })),
      hold: Type.Optional(Type.Boolean({ description: "Only record as a to-do; wait for the user to start it manually" })),
      id: Type.Optional(Type.String({ description: "Task id for stop / revise" })),
      text: Type.Optional(Type.String({ description: "For revise: the message to that task" })),
      done_when: Type.Optional(Type.String({ description: "Completion criteria: one sentence on what counts as done" })),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx) {
      const from: string | undefined = ctx?.sessionManager?.getSessionFile?.();
      try {
        const action = p.action ?? "add";
        if (action === "list") {
          const open = opts.tasks.list((t) => OPEN.includes(t.status));
          const recent = opts.tasks.list((t) => !OPEN.includes(t.status)).slice(-5);
          const lines = [...open, ...recent].map((t) => taskLine(t, now()));
          return text(lines.length ? lines.join("\n") : "No tasks yet.");
        }
        if (action === "stop" || action === "cancel") {
          const t = await opts.tasks.stop(p.id ?? "");
          if (!t) return text(`Couldn't stop it: no such task (${p.id}); use action=list to check.`, true);
          return text(t.status === "running" ? `Stopping "${t.title}".` : t.status === "cancelled" ? `Stopped "${t.title}".` : `"${t.title}" is already ${STATUS_LABEL[t.status]}, no need to stop it.`);
        }
        if (action === "revise") {
          const how = opts.tasks.revise(p.id ?? "", p.text ?? "");
          return how ? text(how) : text("Couldn't revise it: no such task, no text given, or it's being done by an external bot.", true);
        }
        if (!p.title?.trim() || !p.prompt?.trim()) return text("add requires title and prompt.", true);
        const bao = p.bao?.trim() || opts.baoOf(from);
        if (!bao || !opts.listBaos().includes(bao)) return text(`No bot "${bao ?? ""}"; options: ${opts.listBaos().join(", ")}`, true);
        let when: string | undefined;
        if (p.when) {
          const d = parseWhen(p.when, now());
          if (!d) return text(`Couldn't understand the time "${p.when}". ${task.description.split(". ").find((s) => s.startsWith("when"))}`, true);
          when = d.toISOString();
        }
        if (p.repeat && !nextRun(p.repeat, now())) return text(`Couldn't understand the repeat rule "${p.repeat}"; you can write: every day 09:00, weekdays 09:00, every Monday 09:00, every hour`, true);
        const t = opts.tasks.start({
          agent: bao,
          title: p.title.trim().slice(0, 30),
          prompt: p.prompt.trim(),
          doneWhen: p.done_when?.trim() || undefined,
          when,
          repeat: p.repeat?.trim() || undefined,
          after: p.after?.trim() || undefined,
          hold: !!p.hold,
          reportTo: from,
          chatId: "app",
        });
        const how = t.repeat
          ? `scheduled task, ${t.repeat}, first run ${showTime(t.when!, now())}`
          : t.status === "todo"
            ? t.hold
              ? "added to to-dos, waiting for you to press start"
              : t.when
              ? `starts ${showTime(t.when, now())}`
              : t.after
                ? `starts after task "${opts.tasks.get(t.after)?.title ?? t.after}" finishes`
                : "added to to-dos, waiting for you to press start"
            : "already started";
        return text(`Recorded "${t.title}" (${bao}): ${how}. When done it will report back to this conversation and the inbox. Task id: ${t.id}`);
      } catch (e) {
        return text(`Couldn't record it: ${(e as Error).message}`, true);
      }
    },
  };

  const ask: ToolDefinition = {
    name: "kiki_ask_user",
    label: "Stop only when material is missing",
    description:
      "Only use in background tasks, and only when something is missing that only the user has: photos, ID documents, verification codes, passwords or accounts not yet provided, or something requiring the user to log in themselves." +
      "For uncertainty about choices or missing preferences that you can judge yourself, don't use it: finish with the most reasonable assumption, and at the very top of the result state what you assumed and that the user can say if they want it changed." +
      "After use, this task will stop and wait for the material; once the user provides it, it will continue in this conversation.",
    promptSnippet: "kiki_ask_user: only stop to ask when a background task is missing something only the user has, like photos/verification codes/passwords",
    promptGuidelines: [
      "Kiki is full auto: when unsure, finish with the most reasonable assumption and start the result with \"I assumed…, say if you want it changed\" — don't stop to ask.",
      "Only use kiki_ask_user when missing material the user holds (photos, ID documents, verification codes, passwords not yet provided, requiring the user to log in); after using it, don't keep working — explain in one or two sentences what's missing and end this round.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "What you need from the user: exactly what's missing, what it's for, and what you'll do next once provided" }),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx) {
      const from: string | undefined = ctx?.sessionManager?.getSessionFile?.();
      const t = from ? opts.tasks.ask(from, p.question ?? "") : undefined;
      if (!t) return text("This isn't a background task; just say what's missing in your answer.", true);
      return text("The user has been told what's missing. Now stop, explain in one or two sentences how far you got and what's missing, then end this round.");
    },
  };

  const watch: ToolDefinition = {
    name: "kiki_watch",
    label: "Keep watching for follow-ups",
    description:
      "Only use in background tasks: when the thing is done but there's a follow-up to wait for (e.g. you signed up and are waiting for a reply email, submitted an application and are waiting for review, placed an order and are waiting for shipment), record it in the watchlist." +
      "When relevant new messages (emails, etc.) arrive later, they'll come back to this conversation and be handed to you, and you continue in the original context. action=add to record (fill in about and match), action=stop when no more watching is needed.",
    promptSnippet: "kiki_watch: when a task is done but there's a follow-up to wait for, record it in the watchlist; new messages come back here to continue",
    promptGuidelines: [
      "When a background task is done, think: will there be a reply, notification, or deadline from the other side afterward? If so, record one with kiki_watch — about states what you're waiting for and what to do when it arrives; match lists a few short words separated by commas (sender, project name, keywords) that the Mailroom uses to filter messages first.",
      "After receiving a watched new message, once the matter is fully done, kiki_watch action=stop.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("add"), Type.Literal("stop")], { description: "defaults to add" })),
      about: Type.Optional(Type.String({ description: "What you're waiting for and what to do when it arrives, one or two sentences, e.g.: waiting for the review result of the XX project application; once approved, submit materials per the email" })),
      match: Type.Optional(Type.String({ description: "How to recognize relevant messages: a few short words separated by commas (sender, project name, keywords), e.g.: XX Foundation, application, review" })),
      until: Type.Optional(Type.String({ description: "Watch until when (optional), e.g. 2026-12-01 or +30d" })),
    }),
    async execute(_id, p: any, _signal, _onUpdate, ctx) {
      const from: string | undefined = ctx?.sessionManager?.getSessionFile?.();
      const t = from ? opts.tasks.bySession(from) : undefined;
      if (!t) return text("kiki_watch is only used in background tasks.", true);
      const list = opts.watch?.();
      if (!list) return text("The watchlist isn't connected yet (Mailroom isn't running); for now, write clearly in the result what to watch for later.", true);
      try {
        if (p.action === "stop") {
          await list.remove(t.id, t.agent);
          opts.tasks.setWatching(t.id, undefined);
          return text("No longer watching this.");
        }
        if (!p.about?.trim() || !p.match?.trim()) return text("add requires about and match.", true);
        const about = p.about.trim();
        await list.add({ taskId: t.id, title: t.title, about, match: p.match.trim(), until: p.until?.trim() || undefined, agent: t.agent, session: t.session });
        opts.tasks.setWatching(t.id, about);
        return text(`Added to the watchlist: ${about}. Relevant new messages will come back to this conversation and be handed to you.`);
      } catch (e) {
        return text(`Couldn't record it: ${(e as Error).message}`, true);
      }
    },
  };

  return [task, ask, watch];
}
