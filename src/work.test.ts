import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseClassified, parseWork, renderWork, WorkBook, WorkSorter } from "./work.js";

const book = () => {
  const root = mkdtempSync(join(tmpdir(), "kiki-work-"));
  return new WorkBook((a) => join(root, "agents", a));
};

test("work file reads back the same after being written out", () => {
  const b = book();
  const w = b.create("Crypto bot", { title: "ETH DCA plan", goal: "Auto-buy every week: don't chase highs", threads: ["/a.jsonl"], progress: [{ at: "2026-11-03 10:00", text: "Backtest done" }] });
  const back = parseWork(renderWork(w))!;
  assert.equal(back.title, "ETH DCA plan");
  assert.equal(back.goal, "Auto-buy every week: don't chase highs");
  assert.deepEqual(back.threads, ["/a.jsonl"]);
  assert.deepEqual(back.progress, [{ at: "2026-11-03 10:00", text: "Backtest done" }]);
  assert.equal(b.list("Crypto bot").length, 1);
});

test("model output is cleaned up into an array; chit-chat is an empty array; garbage is unrecognized", () => {
  assert.deepEqual(parseClassified("Sure:\n[]"), []);
  const r = parseClassified('```json\n[{"work":"new","title":"Q3 holdings report","status":"doing","next":""}]\n```')!;
  assert.equal(r[0].title, "Q3 holdings report");
  assert.equal(r[0].next, "");
  assert.equal(parseClassified("I don't know"), undefined);
  assert.equal(parseClassified('[{"status":"garbage"}]')![0].status, undefined);
});

test("classification: create new, merge into the same item again, record progress; don't create duplicates for the same title", () => {
  const b = book();
  let w = b.apply("Crypto bot", "/a", [{ work: "new", title: "ETH DCA plan", progress: "Decided to buy only ETH" }])[0];
  w = b.apply("Crypto bot", "/b", [{ work: w.id, next: "Waiting on you to set the amount", progress: "Backtest done" }])[0];
  assert.deepEqual(w.threads, ["/a", "/b"]);
  assert.equal(w.next, "Waiting on you to set the amount");
  assert.equal(w.progress.length, 2);
  b.apply("Crypto bot", "/c", [{ work: "new", title: "ETH DCA plan" }]); // model forgot the id
  assert.equal(b.list("Crypto bot").length, 1);
});

test("manual: a detached conversation is no longer merged back; merging combines conversations and progress", () => {
  const b = book();
  const a = b.apply("bot", "/a", [{ work: "new", title: "A", progress: "one" }])[0];
  const c = b.apply("bot", "/c", [{ work: "new", title: "B", progress: "two" }])[0];
  b.detach("bot", a.id, "/a");
  b.apply("bot", "/a", [{ work: a.id, progress: "again" }]);
  assert.deepEqual(b.get("bot", a.id)!.threads, []);
  const m = b.merge("bot", c.id, a.id)!;
  assert.deepEqual(m.threads, ["/c"]);
  assert.ok(m.progress.some((p) => p.text === "two"));
  assert.equal(b.list("bot").length, 1);
  assert.equal(b.set("bot", a.id, { status: "done" })!.status, "done");
});

test("sorter: background conversations are skipped, model errors leave work untouched", async () => {
  const b = book();
  let out = '[{"work":"new","title":"Switch exchanges","status":"todo"}]';
  const s = new WorkSorter({
    book: b,
    thread: (p) => ({ agent: "bot", name: p }),
    history: () => [{ role: "user", text: "Switch to a different exchange next week" }],
    complete: async () => {
      if (out === "fail") throw new Error("no key");
      return out;
    },
    skip: (p) => p === "/bg",
  });
  assert.equal((await s.run("/bg")).length, 0);
  assert.equal((await s.run("/a"))[0].status, "todo");
  out = "fail";
  assert.equal((await s.run("/a")).length, 0);
  assert.equal(b.list("bot").length, 1);
});

test("dropped work: classification doesn't change it and doesn't create a new one with the same title; if the conversation is deleted while waiting on the model, the result is discarded", async () => {
  const b = book();
  const w = b.apply("bot", "/a", [{ work: "new", title: "Switch exchanges" }])[0];
  b.set("bot", w.id, { status: "dropped" });
  b.apply("bot", "/a", [{ work: w.id, status: "doing" }, { work: "new", title: "Switch exchanges" }]);
  assert.equal(b.list("bot").length, 1);
  assert.equal(b.get("bot", w.id)!.status, "dropped");

  let alive = true, release!: (v: string) => void;
  const s = new WorkSorter({
    book: b,
    thread: (p) => (alive ? { agent: "bot", name: p } : undefined),
    history: () => [{ role: "user", text: "Make a report" }],
    complete: () => new Promise((r) => (release = r)),
  });
  const run = s.run("/z");
  await new Promise((x) => setTimeout(x, 5));
  alive = false;
  release('[{"work":"new","title":"Q3 report"}]');
  assert.equal((await run).length, 0);
  assert.equal(b.list("bot").length, 1);
});
