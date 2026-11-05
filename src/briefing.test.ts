import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEFING, briefing, ensureBriefing } from "./briefing.js";
import { MemoryTaskStore, type Task, type TaskBackend, Tasks } from "./tasks.js";

const now = new Date("2026-11-03T08:30:00"); // Tuesday
const at = (h: string) => new Date(`2026-11-03T${h}:00`).toISOString();
const base = { agent: "dev", prompt: "p", created: at("00:00") } as const;
const task = (o: Partial<Task>): Task => ({ ...base, id: o.title!, status: "todo", ...o }) as Task;

test("briefing: waiting on you, failed, done, due today, listed in sections; anything older than a day is excluded", () => {
  const text = briefing(
    [
      task({ title: "Write weekly report", status: "done", finished: at("01:00") }),
      task({ title: "Sign up", status: "done", finished: "2026-10-27T08:00:00.000Z", watching: "waiting for review result" }),
      task({ title: "Old task", status: "done", finished: "2026-11-01T08:00:00.000Z" }),
      task({ title: "Scrape data", status: "failed", finished: at("02:00"), result: "Website won't open\nDetails…" }),
      task({ title: "Book flight", status: "blocked", question: "Window or aisle?" }),
      task({ title: "Tidy inbox", when: at("10:00"), repeat: "weekdays 10:00" }),
      task({ title: "Tomorrow's thing", when: "2026-11-04T09:00:00" }),
      task({ title: "Jot it down", hold: true }),
      task({ title: "Run tests", status: "running" }),
      task({ title: "Daily briefing", when: at("08:30"), repeat: "every day 08:30", executor: BRIEFING }),
    ],
    now,
    { approvals: 2 },
  );
  assert.match(text, /^☀️ Good morning, today is Tue, November 3\./);
  assert.match(text, /\*\*Waiting on you\*\* \(2\)\n- Book flight: Window or aisle\? \(\/answer Book flight your answer\)\n- 2 more cards waiting on your approval/);
  assert.match(text, /\*\*Didn't get done\*\* \(1\)\n- Scrape data: Website won't open → \/retry Scrape data/);
  assert.match(text, /\*\*Done since yesterday\*\* \(1\)\n- Write weekly report · dev/);
  assert.match(text, /\*\*To do today\*\* \(2\)\n- In progress: Run tests · dev\n- today 10:00 Tidy inbox · dev \(weekdays 10:00\)/);
  assert.match(text, /\*\*Still watching\*\* \(1\)\n- Sign up: waiting for review result/);
  assert.match(text, /Also, 1 item is saved in your to-dos, waiting for you to start/);
  assert.doesNotMatch(text, /Old task|Tomorrow's thing|Daily briefing ·/);
});

test("briefing: when there's nothing, say so in one line", () => {
  assert.match(briefing([], now), /No new tasks since yesterday, and nothing scheduled for today\./);
});

const backend: TaskBackend = { spawn: async () => "/s", send: async () => "x", note: async () => {} };

test("daily briefing card: first time creates a scheduled task at 08:30 every day; if one exists (including cancelled) don't create another; when due, the executor produces the body", async () => {
  let t = new Date("2026-11-03T08:29:59.950").getTime();
  const tasks = new Tasks(new MemoryTaskStore(), backend, { now: () => new Date(t) });
  tasks.registerExecutor(BRIEFING, { run: async () => briefing(tasks.list(), new Date(t)) });
  const tpl = ensureBriefing(tasks, { agent: "Kiki" })!;
  assert.equal(tpl.repeat, "every day 08:30");
  assert.equal(tpl.status, "todo");
  assert.equal(new Date(tpl.when!).getHours(), 8);
  assert.equal(ensureBriefing(tasks, { agent: "Kiki" }), undefined);
  t += 50;
  await new Promise((r) => setTimeout(r, 150));
  const run = tasks.list((x) => x.parent === tpl.id)[0];
  assert.equal(run?.status, "done");
  assert.match(run.result!, /Good morning/);
  assert.equal(new Date(tpl.when!).getDate(), 4, "moved to tomorrow");
  tasks.cancel(tpl.id);
  assert.equal(ensureBriefing(tasks, { agent: "Kiki" }), undefined, "not recreated after cancel");
});
