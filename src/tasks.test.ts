import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileTaskStore, formatTask, MemoryTaskStore, parseTask, type Task, type TaskBackend, Tasks } from "./tasks.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function fakeBackend(sendImpl?: (text: string) => Promise<string>) {
  let n = 0;
  const notes: string[] = [];
  const aborted: string[] = [];
  const backend: TaskBackend = {
    spawn: async (a, title) => `/fake/${a}/${title}-${++n}.jsonl`,
    send: (_a, _p, text) => (sendImpl ? sendImpl(text) : Promise.resolve(`Done: ${text}`)),
    abort: async (p) => void aborted.push(p),
    note: async (p, text) => void notes.push(`${p} ${text}`),
  };
  return { backend, notes, aborted };
}

test("task file: Markdown + YAML, what's written can be read back verbatim", () => {
  const t: Task = {
    id: "20261101-120000-abc",
    title: "Write weekly report",
    status: "done",
    agent: "dev",
    prompt: "Help me write the weekly report\nsecond line",
    origin: "/x/a.jsonl",
    created: "2026-11-01T12:00:00.000Z",
    result: "## This week\n- Built Kiki",
  };
  const md = formatTask(t);
  assert.match(md, /^---\nid: "20261101-120000-abc"\ntitle: "Write weekly report"\nstatus: "done"/);
  assert.match(md, /\n## Task\n\nHelp me write the weekly report\nsecond line\n\n<!-- kiki:result -->\n## Result\n\n## This week/);
  assert.deepEqual(parseTask(md), t);
});

test("a task prompt containing \"## Result\" is not truncated", () => {
  const base = { id: "x", title: "Template", agent: "dev", created: "", prompt: "Write in this format:\n\n## Result\n\n- Key points" };
  assert.deepEqual(parseTask(formatTask({ ...base, status: "queued" })), { ...base, status: "queued" });
  const done = { ...base, status: "done" as const, result: "Done" };
  assert.deepEqual(parseTask(formatTask(done)), done);
});

test("unquoted values from manual edits are accepted", () => {
  const t = parseTask("---\nid: x1\nstatus: failed\nagent: life\n---\n\n## Task\n\nBuy groceries\n");
  assert.equal(t?.status, "failed");
  assert.equal(t?.prompt, "Buy groceries");
});

test("on completion: status written to file, reported back to the original conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-tasks-"));
  const { backend, notes } = fakeBackend();
  const tasks = new Tasks(new FileTaskStore(dir), backend);
  const seen: string[] = [];
  const t = tasks.start({ agent: "dev", title: "Tidy up", prompt: "Tidy up the README", origin: "/o.jsonl" }, (x) => seen.push(x.status));
  await tick();
  assert.equal(t.status, "done");
  assert.deepEqual(seen, ["queued", "running", "running", "done"]); // the second running is when the background conversation is recorded
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{8}-\d{6}-\w+ Tidy up\.md$/);
  const md = readFileSync(join(dir, files[0]), "utf8");
  assert.match(md, /status: "done"/);
  assert.match(md, /## Result\n\nDone: Tidy up the README/);
  assert.match(notes[0], /^\/o\.jsonl ✅ Background task "Tidy up" completed/);
});

test("at most concurrency tasks run at once, the rest queue", async () => {
  const gates: (() => void)[] = [];
  const { backend } = fakeBackend((text) => new Promise((r) => gates.push(() => r(text))));
  const tasks = new Tasks(new FileTaskStore(mkdtempSync(join(tmpdir(), "kiki-tasks-"))), backend, { concurrency: 2 });
  const ts = [1, 2, 3].map((i) => tasks.start({ agent: "dev", title: `t${i}`, prompt: `p${i}` }));
  await tick();
  assert.deepEqual(ts.map((t) => t.status), ["running", "running", "queued"]);
  gates.shift()!();
  await tick();
  assert.deepEqual(ts.map((t) => t.status), ["done", "running", "running"]);
  gates.forEach((g) => g());
  await tick();
  assert.ok(ts.every((t) => t.status === "done"));
});

test("a hang while opening the conversation counts as a timeout; no work starts afterwards and the slot is freed", async () => {
  let release!: (p: string) => void;
  const sent: string[] = [];
  const { backend } = fakeBackend(async (text) => (sent.push(text), "ok"));
  const spawn = backend.spawn;
  let first = true;
  backend.spawn = (a, title, from) => {
    if (!first) return spawn(a, title, from);
    first = false;
    return new Promise((r) => (release = r)); // the first task hangs opening its conversation
  };
  const tasks = new Tasks(new FileTaskStore(mkdtempSync(join(tmpdir(), "kiki-tasks-"))), backend, { concurrency: 1, timeoutMs: 20 });
  const a = tasks.start({ agent: "dev", title: "Stuck", prompt: "pa" });
  const b = tasks.start({ agent: "dev", title: "Next", prompt: "pb" });
  await tick(50);
  assert.equal(a.status, "failed");
  assert.equal(b.status, "done");
  release("/late.jsonl");
  await tick();
  assert.deepEqual(sent, ["pb"]);
});

test("when the original conversation is busy and reports are queued, the next queued task still starts", async () => {
  const { backend } = fakeBackend();
  backend.note = () => new Promise(() => {}); // the original conversation stays busy
  const tasks = new Tasks(new FileTaskStore(mkdtempSync(join(tmpdir(), "kiki-tasks-"))), backend, { concurrency: 1 });
  tasks.start({ agent: "dev", title: "a", prompt: "pa", origin: "/o.jsonl" });
  const b = tasks.start({ agent: "dev", title: "b", prompt: "pb" });
  await tick();
  assert.equal(b.status, "done");
});

test("timeout: stop the conversation, mark as failed", async () => {
  const { backend, aborted } = fakeBackend(() => new Promise(() => {}));
  const tasks = new Tasks(new FileTaskStore(mkdtempSync(join(tmpdir(), "kiki-tasks-"))), backend, { timeoutMs: 20 });
  const t = tasks.start({ agent: "dev", title: "Slow", prompt: "p" });
  await tick(50);
  assert.equal(t.status, "failed");
  assert.match(t.result!, /Didn't finish within 0 minutes, stopped/);
  assert.deepEqual(aborted, [t.session]);
});

test("restart: unfinished tasks are marked interrupted and can be retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-tasks-"));
  const a = fakeBackend(() => new Promise(() => {}));
  new Tasks(new FileTaskStore(dir), a.backend).start({ agent: "dev", title: "Long job", prompt: "p" });
  await tick();
  // simulate a restart: read back from files
  const b = fakeBackend();
  const tasks = new Tasks(new FileTaskStore(dir), b.backend);
  const lost = tasks.recover();
  assert.equal(lost.length, 1);
  assert.equal(lost[0].status, "interrupted");
  assert.match(readFileSync(join(dir, readdirSync(dir)[0]), "utf8"), /status: "interrupted"/);
  const again = tasks.retry(lost[0].id)!;
  await tick();
  assert.equal(again.status, "done");
  assert.equal(readdirSync(dir).length, 2);
});

test("reportTo: no fork, only report to the given conversation; retries keep it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-tasks-"));
  const froms: (string | undefined)[] = [];
  const { backend, notes } = fakeBackend();
  const spawn = backend.spawn;
  backend.spawn = (a, title, from) => (froms.push(from), spawn(a, title, from));
  const tasks = new Tasks(new FileTaskStore(dir), backend);
  const t = tasks.start({ agent: "dev", title: "Handoff", prompt: "p", reportTo: "/r.jsonl" });
  await tick();
  assert.deepEqual(froms, [undefined]);
  assert.match(notes[0], /^\/r\.jsonl ✅/);
  const reloaded = new Tasks(new FileTaskStore(dir), backend);
  assert.equal(reloaded.get(t.id)?.reportTo, "/r.jsonl");
  reloaded.retry(t.id);
  await tick();
  assert.match(notes[1], /^\/r\.jsonl ✅/);
});

// ---------- to-do, scheduled, dependencies, waiting on you ----------

function clock(start: string) {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

test("scheduled: a future when goes to the to-do list and starts automatically when due", async () => {
  const c = clock("2026-11-02T08:00:00");
  const { backend } = fakeBackend();
  const tasks = new Tasks(new MemoryTaskStore(), backend, { now: c.now });
  const t = tasks.start({ agent: "dev", title: "Reminder", prompt: "p", when: new Date(c.now().getTime() + 30).toISOString() });
  assert.equal(t.status, "todo");
  c.advance(30);
  await tick(150); // alarm + 50ms margin
  assert.equal(t.status, "done");
});

test("to-do items that came due while shut down: caught up on recover", async () => {
  const c = clock("2026-11-02T08:00:00");
  const store = new MemoryTaskStore();
  const { backend } = fakeBackend();
  const t = new Tasks(store, backend, { now: c.now }).start({ agent: "dev", title: "Morning briefing", prompt: "p", when: "2026-11-02T09:00:00" });
  c.advance(2 * 3_600_000);
  const again = new Tasks(store, backend, { now: c.now });
  again.recover();
  await tick();
  assert.equal(again.get(t.id)?.status, "done");
});

test("repeat: the scheduled task stays in the to-do list, each due time spawns a separate task and moves to the next", async () => {
  const c = clock("2026-11-02T08:59:59.990");
  const { backend } = fakeBackend();
  const tasks = new Tasks(new MemoryTaskStore(), backend, { now: c.now });
  const tpl = tasks.start({ agent: "dev", title: "Morning briefing", prompt: "Compile the morning briefing", repeat: "every day 09:00" });
  assert.equal(tpl.status, "todo");
  assert.equal(new Date(tpl.when!).getHours(), 9);
  c.advance(20);
  await tick(120);
  const runs = tasks.list((t) => t.parent === tpl.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(tpl.status, "todo");
  assert.equal(new Date(tpl.when!).getDate(), 3, "next run is tomorrow at 9");
  // run now: spawns an extra one without changing the next time
  tasks.runNow(tpl.id);
  await tick();
  assert.equal(tasks.list((t) => t.parent === tpl.id).length, 2);
  assert.equal(new Date(tpl.when!).getDate(), 3);
  // cancel the scheduled task
  tasks.cancel(tpl.id);
  assert.equal(tpl.status, "cancelled");
});

test("an unrecognized repeat rule throws", () => {
  const tasks = new Tasks(new MemoryTaskStore(), fakeBackend().backend);
  assert.throws(() => tasks.start({ agent: "dev", title: "x", prompt: "p", repeat: "occasionally" }), /Could not understand repeat rule/);
});

test("wait for A to finish before B; if A fails, B is marked failed", async () => {
  const gates: ((v: string) => void)[] = [];
  const fails: ((e: Error) => void)[] = [];
  const { backend } = fakeBackend((text) => new Promise((r, j) => (gates.push(r), fails.push(j))));
  const tasks = new Tasks(new MemoryTaskStore(), backend);
  const a = tasks.start({ agent: "dev", title: "A", prompt: "pa" });
  const b = tasks.start({ agent: "dev", title: "B", prompt: "pb", after: a.id });
  await tick();
  assert.equal(b.status, "todo");
  gates[0]("ok");
  await tick();
  assert.equal(a.status, "done");
  assert.equal(b.status, "running");
  gates[1]("ok");
  await tick();
  const c = tasks.start({ agent: "dev", title: "C", prompt: "pc" });
  const d = tasks.start({ agent: "dev", title: "D", prompt: "pd", after: c.id });
  await tick();
  fails[2](new Error("broke"));
  await tick();
  assert.equal(d.status, "failed");
  assert.match(d.result!, /The task it was waiting on, "C", Failed/);
  // retry D: no longer waits on C
  const d2 = tasks.retry(d.id)!;
  assert.equal(d2.after, undefined);
});

test("hold: goes to the to-do list, runs only when started", async () => {
  const { backend } = fakeBackend();
  const tasks = new Tasks(new MemoryTaskStore(), backend);
  const t = tasks.start({ agent: "dev", title: "Do later", prompt: "p", hold: true });
  await tick();
  assert.equal(t.status, "todo");
  tasks.runNow(t.id);
  await tick();
  assert.equal(t.status, "done");
});

test("stuck, asks a human: stops at waiting on you, continues in the original conversation after the answer, reports on completion", async () => {
  const sent: string[] = [];
  let tasks!: Tasks;
  const { backend, notes } = fakeBackend(async (text) => {
    sent.push(text);
    if (text === "Write weekly report") {
      tasks.ask(tasks.list()[0].session!, "Is this week's focus Kiki or something else?");
      return "Stuck: don't know the focus";
    }
    return `Okay, finished writing based on "${text}"`;
  });
  tasks = new Tasks(new MemoryTaskStore(), backend);
  const seen: string[] = [];
  const t = tasks.start({ agent: "dev", title: "Weekly report", prompt: "Write weekly report", origin: "/o.jsonl" }, (x) => seen.push(x.status));
  await tick();
  assert.equal(t.status, "blocked");
  assert.equal(t.question, "Is this week's focus Kiki or something else?");
  assert.equal(notes.length, 0, "no report to the original conversation while blocked");
  assert.equal(tasks.blockedBySession(t.session!)?.id, t.id);
  const session = t.session;
  tasks.answer(t.id, "Kiki");
  await tick();
  assert.equal(t.status, "done");
  assert.equal(t.session, session, "continues in the same background conversation");
  assert.equal(t.question, undefined);
  assert.deepEqual(sent, ["Write weekly report", "Kiki"]);
  assert.match(notes[0], /✅ Background task "Weekly report" completed/);
  assert.ok(seen.includes("blocked"));
});

test("ask in a conversation that isn't a background task returns undefined", () => {
  const tasks = new Tasks(new MemoryTaskStore(), fakeBackend().backend);
  assert.equal(tasks.ask("/random.jsonl", "?"), undefined);
});

test("scheduling fields written to file can be read back", () => {
  const t: Task = { id: "x", title: "Morning briefing", status: "todo", agent: "dev", prompt: "p", created: "", repeat: "every day 09:00", when: "2026-11-03T01:00:00.000Z" };
  assert.deepEqual(parseTask(formatTask(t)), t);
});

test("dependency failure propagates down the chain: A cancelled → B and C both marked failed", () => {
  const tasks = new Tasks(new MemoryTaskStore(), fakeBackend().backend);
  const a = tasks.start({ agent: "dev", title: "A", prompt: "p", hold: true });
  const b = tasks.start({ agent: "dev", title: "B", prompt: "p", after: a.id });
  const c = tasks.start({ agent: "dev", title: "C", prompt: "p", after: b.id });
  tasks.cancel(a.id);
  assert.equal(b.status, "failed");
  assert.equal(c.status, "failed");
  assert.ok(tasks.retry(c.id), "downstream tasks can be retried too");
});

test("a task stuck on a question also queues, without exceeding the concurrency limit", async () => {
  const gates: (() => void)[] = [];
  let tasks!: Tasks;
  const { backend } = fakeBackend((text) => {
    if (text === "ask") {
      tasks.ask(tasks.list((t) => t.prompt === "ask")[0].session!, "?");
      return Promise.resolve("stuck");
    }
    return new Promise((r) => gates.push(() => r(text)));
  });
  tasks = new Tasks(new MemoryTaskStore(), backend, { concurrency: 1 });
  const q = tasks.start({ agent: "dev", title: "q", prompt: "ask" });
  await tick();
  assert.equal(q.status, "blocked");
  const other = tasks.start({ agent: "dev", title: "o", prompt: "other" });
  await tick();
  assert.equal(other.status, "running");
  tasks.answer(q.id, "answer");
  await tick();
  assert.equal(q.status, "queued", "the slot is taken, so the answer queues first");
  gates.shift()!();
  await tick();
  assert.equal(other.status, "done");
  assert.equal(q.status, "running");
  gates.shift()!();
  await tick();
  assert.equal(q.status, "done");
  assert.equal(q.result, "answer");
});

test("a scheduled task waiting on its prerequisite: hand off to the alarm to spawn a subtask, don't run the scheduled task itself", async () => {
  const c = clock("2026-11-02T08:00:00");
  const gates: (() => void)[] = [];
  const { backend } = fakeBackend((text) => (text === "prereq" ? new Promise((r) => gates.push(() => r(text))) : Promise.resolve(text)));
  const tasks = new Tasks(new MemoryTaskStore(), backend, { now: c.now });
  const pre = tasks.start({ agent: "dev", title: "prereq", prompt: "prereq" });
  const tpl = tasks.start({ agent: "dev", title: "morning report", prompt: "morning report", repeat: "every day 09:00", after: pre.id });
  c.advance(2 * 3_600_000); // past 9 o'clock, prerequisite still not done
  await tick(80);
  assert.equal(tasks.list((t) => t.parent === tpl.id).length, 0);
  gates.shift()!();
  await tick(80);
  assert.equal(tpl.status, "todo", "the scheduled task is still there");
  assert.equal(tasks.list((t) => t.parent === tpl.id).length, 1);
});

test("hold: neither the due time nor a finished prerequisite runs it automatically; it's recorded to file and only runs when you press start", async () => {
  const c = clock("2026-11-02T08:00:00");
  const store = new MemoryTaskStore();
  const tasks = new Tasks(store, fakeBackend().backend, { now: c.now });
  const t = tasks.start({ agent: "dev", title: "x", prompt: "p", hold: true, when: "2026-11-02T07:00:00" });
  await tick(80);
  assert.equal(t.status, "todo");
  assert.equal(parseTask(formatTask(t))?.hold, true);
  tasks.runNow(t.id);
  await tick();
  assert.equal(t.status, "done");
  assert.equal(t.hold, undefined);
});

// ---------- 0.2.65: done criteria, stop, revise, rework, external executors ----------

test("done criteria are written to file and appended to the task when handed to the background conversation", async () => {
  const sent: string[] = [];
  const { backend } = fakeBackend(async (t) => (sent.push(t), "ok"));
  const tasks = new Tasks(new MemoryTaskStore(), backend);
  const t = tasks.start({ agent: "dev", title: "x", prompt: "write the weekly report", doneWhen: "list 3 things you finished" });
  await tick();
  assert.match(sent[0], /^write the weekly report\n\nCompletion criteria: list 3 things you finished\n/);
  assert.equal(parseTask(formatTask(t))?.doneWhen, "list 3 things you finished");
});

test("stop a task: a running one stops its conversation and is marked cancelled, not failed", async () => {
  let reject!: (e: Error) => void;
  const { backend, aborted } = fakeBackend(() => new Promise((_, j) => (reject = j)));
  backend.abort = async (p) => {
    aborted.push(p);
    reject(new Error("aborted"));
  };
  const tasks = new Tasks(new MemoryTaskStore(), backend);
  const t = tasks.start({ agent: "dev", title: "long job", prompt: "p" });
  await tick();
  await tasks.stop(t.id);
  await tick();
  assert.equal(t.status, "cancelled");
  assert.deepEqual(aborted, [t.session]);
});

test("revise a task: a queued one gets its content changed, a running one gets a steer, a finished one reworks in the original conversation and reports back again", async () => {
  const gates: (() => void)[] = [];
  const sent: string[] = [];
  const steered: string[] = [];
  const { backend, notes } = fakeBackend((text) => (sent.push(text), text === "A" ? new Promise((r) => gates.push(() => r("A done"))) : Promise.resolve(`done: ${text}`)));
  backend.steer = async (p, text) => void steered.push(`${p} ${text}`);
  const tasks = new Tasks(new MemoryTaskStore(), backend, { concurrency: 1 });
  const a = tasks.start({ agent: "dev", title: "A", prompt: "A", origin: "/o.jsonl" });
  const b = tasks.start({ agent: "dev", title: "B", prompt: "B" });
  await tick();
  assert.match(tasks.revise(b.id, "also write a conclusion")!, /Updated the task content/);
  assert.match(tasks.revise(a.id, "hurry up")!, /Interjected/);
  assert.deepEqual(steered, [`${a.session} hurry up`]);
  gates.shift()!();
  await tick();
  assert.equal(sent[1], "B\n\nAdditional note: also write a conclusion");
  assert.equal(a.status, "done");
  const session = a.session;
  assert.match(tasks.revise(a.id, "add one more table")!, /rework in the original conversation/);
  await tick();
  assert.equal(a.status, "done");
  assert.equal(a.session, session);
  assert.equal(a.result, "done: Rework: add one more table");
  assert.equal(notes.length, 2, "reports back again after rework");
});

test("external executor: handed to a registered executor, fails if it can't connect", async () => {
  const tasks = new Tasks(new MemoryTaskStore(), fakeBackend().backend);
  const stopped: string[] = [];
  tasks.registerExecutor("grokbot", { run: async (t) => `grok finished: ${t.prompt}`, stop: (t) => void stopped.push(t.id) });
  const t = tasks.start({ agent: "dev", title: "look up info", prompt: "look up A2A", executor: "grokbot" });
  const u = tasks.start({ agent: "dev", title: "x", prompt: "p", executor: "nonexistent" });
  await tick();
  assert.equal(t.status, "done");
  assert.equal(t.result, "grok finished: look up A2A");
  assert.equal(t.session, undefined);
  assert.equal(u.status, "failed");
  assert.match(u.result!, /No executor named "nonexistent"/);
});

test("external executor: looked up by name on the fly; stopping the task aborts the signal and marks it cancelled", async () => {
  const tasks = new Tasks(new MemoryTaskStore(), fakeBackend().backend);
  let seen: AbortSignal | undefined;
  tasks.executorFor = (name) =>
    name === "codex"
      ? {
          run: (_t, signal) =>
            new Promise<string>((_, reject) => {
              seen = signal;
              signal.addEventListener("abort", () => reject(new Error("the other side stopped")));
            }),
        }
      : undefined;
  const t = tasks.start({ agent: "dev", title: "write code", prompt: "p", executor: "codex" });
  await tick();
  assert.equal(t.status, "running");
  await tasks.stop(t.id);
  await tick();
  assert.equal(seen?.aborted, true);
  assert.equal(t.status, "cancelled");
});

test("new message on a watched item: go back to the original conversation and continue, report back when done; cancelled and unknown ones are ignored", async () => {
  const sent: string[] = [];
  const { backend, notes } = fakeBackend(async (text) => (sent.push(text), `handled: ${text.slice(0, 12)}`));
  const tasks = new Tasks(new MemoryTaskStore(), backend);
  const t = tasks.start({ agent: "dev", title: "sign up", prompt: "help me sign up for project X", reportTo: "/r.jsonl" });
  await tick();
  const session = t.session!;
  tasks.setWatching(t.id, "waiting for the organizer's review result");
  assert.equal(tasks.bySession(session)?.id, t.id);
  assert.equal(tasks.followUp(t.id, "email: review passed, please submit materials by 11/10"), "Back in the original conversation, continuing the work");
  await tick();
  assert.equal(t.status, "done");
  assert.equal(t.session, session);
  assert.match(sent[1], /There's new news about what you're watching \(waiting for the organizer's review result\):\n\nemail: review passed, please submit materials by 11\/10/);
  assert.equal(notes.length, 2, "reports back after finishing");
  assert.equal(t.watching, "waiting for the organizer's review result", "still watching, until the agent says it's no longer needed");
  assert.equal(tasks.followUp("nonexistent", "new message"), undefined);
  const u = tasks.start({ agent: "dev", title: "x", prompt: "p", hold: true });
  tasks.cancel(u.id);
  assert.equal(tasks.followUp(u.id, "new message"), undefined, "cancelled ones are ignored");
});

test("stopped while opening the conversation: the task is never sent, marked cancelled", async () => {
  let release!: () => void;
  const sent: string[] = [];
  const backend: TaskBackend = {
    spawn: () => new Promise((r) => (release = () => r("/slow.jsonl"))),
    send: async (_a, _p, text) => (sent.push(text), "done"),
    note: async () => {},
  };
  const tasks = new Tasks(new MemoryTaskStore(), backend);
  const t = tasks.start({ agent: "dev", title: "delete stuff", prompt: "delete the old files" });
  await tick();
  await tasks.stop(t.id);
  release();
  await tick();
  assert.deepEqual(sent, []);
  assert.equal(t.status, "cancelled");
});

test("revising again while queued for rework: both messages go to the original conversation", async () => {
  const sent: string[] = [];
  let hold!: () => void;
  const gate = new Promise<void>((r) => (hold = r));
  const { backend } = fakeBackend(async (text) => {
    sent.push(text);
    if (text === "placeholder") await gate;
    return "ok";
  });
  const tasks = new Tasks(new MemoryTaskStore(), backend, { concurrency: 1 });
  const a = tasks.start({ agent: "dev", title: "weekly report", prompt: "write the weekly report" });
  await tick();
  tasks.start({ agent: "dev", title: "placeholder", prompt: "placeholder" }); // occupy the only slot
  await tick();
  tasks.revise(a.id, "add a table");
  assert.equal(a.status, "queued");
  tasks.revise(a.id, "also add next week's plan");
  hold();
  await tick(50);
  assert.equal(sent.at(-1), "Rework: add a table\n\nAdditional note: also add next week's plan");
  assert.equal(a.prompt, "write the weekly report");
});
