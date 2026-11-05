import { test } from "node:test";
import assert from "node:assert/strict";
import { Acks, markForReply, taskMark } from "./ack.js";
import { cleanAck, roleModel } from "./modelroles.js";
import type { Task } from "./tasks.js";

test("👀 right away on a new message, queued while busy, 👀 when it's their turn, cleared once answered", () => {
  const a = new Acks();
  const seen: unknown[] = [];
  a.on("change", (d) => seen.push(d));
  const id1 = a.add("p", "hello");
  const id2 = a.add("p", "one more", true);
  assert.equal(a.get(id1)?.mark, "seen");
  assert.equal(a.get(id2)?.mark, "queued");
  a.set(id1, null);
  assert.equal(a.get(id1), undefined);
  a.start(id2);
  assert.equal(a.get(id2)?.mark, "seen");
  assert.equal(seen.length, 4);
});

test("quick ack: ones that arrive before the answer are kept (even after the mark is cleared), ones that arrive after are dropped", () => {
  const a = new Acks();
  const id = a.add("p", "check this for me");
  a.say(id, "Sure, let me look at the calendar first");
  a.set(id, null);
  assert.equal(a.get(id)?.say, "Sure, let me look at the calendar first");
  assert.equal(a.get(id)?.mark, null);
  const late = a.add("p", "one more thing");
  a.set(late, null);
  a.say(late, "too late");
  assert.equal(a.get(late), undefined);
});

test("background task status drives the mark", () => {
  const a = new Acks();
  const id = a.add("main", "tidy this up");
  a.link(id, [{ id: "t1", status: "running" } as Task]);
  assert.equal(a.get(id)?.mark, "bg");
  assert.equal(a.linked("t1"), true);
  a.onTask({ id: "t1", status: "blocked" } as Task);
  assert.equal(a.get(id)?.mark, "ask");
  a.onTask({ id: "t1", status: "done" } as Task);
  assert.equal(a.get(id)?.mark, "done");
  a.onTask({ id: "t2", status: "failed" } as Task); // other tasks don't affect it
  assert.equal(a.get(id)?.mark, "done");
  assert.equal(taskMark({ status: "cancelled" } as Task), null);
});

test("the mark for a Kiki reply", () => {
  assert.equal(markForReply("→ Kiki · background task \"weekly report\"\n\nOkay, handed off to the background"), "bg");
  assert.equal(markForReply("→ Kiki/main chat · handed off to the bot\n\nanswer"), null);
  assert.equal(markForReply("✅ background task \"weekly report\" done:\n\n…"), "done");
  assert.equal(markForReply("❌ background task \"weekly report\" failed: timed out"), "error");
  assert.equal(markForReply("⏸ background task \"weekly report\" is stuck"), "ask");
  assert.equal(markForReply("something went wrong: can't connect"), "error");
  assert.equal(markForReply("split into 2 items:\n- background task \"a\" (Kiki): report back here when done"), "bg");
  assert.equal(markForReply("Kiki · direct answer\n\nhello"), null);
});

test("models configured by purpose: undefined when unset; quick ack cleanup", () => {
  assert.equal(roleModel("route", {}), undefined);
  assert.equal(roleModel("ack", { ACK_MODEL: " deepseek/deepseek-flash " }), "deepseek/deepseek-flash");
  assert.equal(cleanAck("SKIP"), "");
  assert.equal(cleanAck("\"Sure, let me check the calendar\"\nextra"), "Sure, let me check the calendar");
  assert.equal(cleanAck(""), "");
});

test("split into several background items: ✅ only when all are done, ❗ if any one fails", () => {
  const a = new Acks();
  const id = a.add("main", "two things");
  a.link(id, [{ id: "x", status: "queued" } as Task, { id: "y", status: "running" } as Task]);
  a.onTask({ id: "x", status: "done" } as Task);
  assert.equal(a.get(id)?.mark, "bg"); // y is still running
  a.onTask({ id: "y", status: "failed" } as Task);
  assert.equal(a.get(id)?.mark, "error");
  a.onTask({ id: "x", status: "done" } as Task); // a late update won't overwrite the error
  assert.equal(a.get(id)?.mark, "error");
});
