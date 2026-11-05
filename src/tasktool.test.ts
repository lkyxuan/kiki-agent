import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryTaskStore, Tasks } from "./tasks.js";
import { taskTools } from "./tasktool.js";

const now = new Date(2026, 10, 2, 10, 30);
function setup() {
  const sent: string[] = [];
  const tasks = new Tasks(new MemoryTaskStore(), {
    spawn: async (a, title) => `/fake/${a}/${title}.jsonl`,
    send: async (_a, _p, t) => (sent.push(t), "ok"),
    note: async () => {},
  }, { now: () => now });
  const [task, ask] = taskTools({ tasks, listBaos: () => ["dev", "life"], baoOf: () => "dev", now: () => now });
  const ctx = (file?: string) => ({ sessionManager: { getSessionFile: () => file } }) as any;
  const call = async (tool: any, p: any, file = "/from.jsonl") => {
    const r = await tool.execute("id", p, undefined, undefined, ctx(file));
    return { text: r.content[0].text as string, err: !!r.isError };
  };
  return { tasks, task, ask, call, sent };
}

test("kiki_task: scheduled, repeating, waiting, and just noting it down", async () => {
  const { tasks, task, call } = setup();
  let r = await call(task, { title: "Remind me to buy groceries", prompt: "Remind me to buy groceries", when: "tomorrow 18:00" });
  assert.match(r.text, /Noted "Remind me to buy groceries" \(dev\): starts tomorrow 18:00/);
  r = await call(task, { title: "Morning report", prompt: "Put together the morning report", repeat: "weekdays 09:00", bao: "life" });
  assert.match(r.text, /Scheduled task, weekdays 09:00, first run tomorrow 09:00/);
  const first = tasks.list()[0];
  r = await call(task, { title: "Follow-up", prompt: "p", after: first.id });
  assert.match(r.text, /Will start after task "Remind me to buy groceries" finishes/);
  r = await call(task, { title: "Later", prompt: "p", hold: true });
  assert.match(r.text, /Added to your to-dos, waiting for you to hit start/);
  assert.ok(tasks.list().every((t) => t.status === "todo" && t.reportTo === "/from.jsonl"));
  r = await call(task, { action: "list" });
  assert.match(r.text, /\[Scheduled\] Morning report · life · weekdays 09:00, next run tomorrow 09:00/);
  r = await call(task, { action: "cancel", id: first.id });
  assert.match(r.text, /Stopped "Remind me to buy groceries"/);
});

test("kiki_task: unrecognized times and rules, and nonexistent bots, all error out", async () => {
  const { task, call } = setup();
  assert.ok((await call(task, { title: "x", prompt: "p", when: "some other day" })).err);
  assert.ok((await call(task, { title: "x", prompt: "p", repeat: "occasionally" })).err);
  assert.ok((await call(task, { title: "x", prompt: "p", bao: "nonexistent" })).err);
});

test("kiki_ask_user: only works inside background tasks", async () => {
  const { tasks, ask, call } = setup();
  assert.ok((await call(ask, { question: "?" }, "/random.jsonl")).err);
  const t = tasks.start({ agent: "dev", title: "Job", prompt: "p" });
  t.status = "running";
  t.session = "/fake/dev/Job.jsonl";
  const r = await call(ask, { question: "A or B?" }, t.session);
  assert.equal(r.err, false);
});

test("kiki_watch: only used inside background tasks; records to the watchlist and writes to the task card; stop removes it", async () => {
  const tasks = new Tasks(new MemoryTaskStore(), { spawn: async () => "/bg.jsonl", send: async () => "ok", note: async () => {} }, { now: () => now });
  const added: any[] = [];
  const removed: string[] = [];
  let on = false;
  const tools = taskTools({
    tasks,
    listBaos: () => ["dev"],
    baoOf: () => "dev",
    watch: () => (on ? { add: (w) => (added.push(w), "w1"), remove: (id, agent) => void removed.push(`${agent}:${id}`) } : undefined),
  });
  const watch = tools.find((t) => t.name === "kiki_watch")!;
  const call = async (p: any, file: string) => {
    const r: any = await watch.execute("id", p, undefined, undefined, { sessionManager: { getSessionFile: () => file } } as any);
    return { text: r.content[0].text as string, err: !!r.isError };
  };
  assert.equal((await call({ about: "a", match: "m" }, "/chat.jsonl")).err, true);
  const t = tasks.start({ agent: "dev", title: "Sign-up", prompt: "p" });
  await new Promise((r) => setTimeout(r, 10));
  assert.match((await call({ about: "a", match: "m" }, "/bg.jsonl")).text, /not connected yet/);
  on = true;
  const r = await call({ about: "Waiting on the review result; submit materials once approved", match: "sender: Project X" }, "/bg.jsonl");
  assert.match(r.text, /Added to the watchlist/);
  assert.deepEqual(added[0], { taskId: t.id, title: "Sign-up", about: "Waiting on the review result; submit materials once approved", match: "sender: Project X", until: undefined, agent: "dev", session: "/bg.jsonl" });
  assert.equal(t.watching, "Waiting on the review result; submit materials once approved");
  await call({ action: "stop" }, "/bg.jsonl");
  assert.deepEqual(removed, [`dev:${t.id}`]);
  assert.equal(t.watching, undefined);
});
