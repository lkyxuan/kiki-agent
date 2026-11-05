import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deliveryText, MailboxAgent, parseMessage, Postroom } from "./postroom.js";

const old = (file: string) => utimesSync(file, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000)); // past the "just written" wait

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "kiki-pr-"));
  const pr = new Postroom({ dataDir });
  const delivered: string[] = [];
  const answered: string[] = [];
  pr.deliver = async (it) => {
    delivered.push(deliveryText(it, (b) => b === "Work bot"));
    return "→ Work bot/main chat · handed to bot\n\nOkay";
  };
  pr.answer = async (it, sent) => {
    answered.push(`${sent.title}:${it.text}`);
    return true;
  };
  const box = join(dataDir, "postroom", "mailbox", "grokbot");
  mkdirSync(box, { recursive: true });
  const drop = (name: string, body: string) => {
    const f = join(box, "to-kiki", name);
    mkdirSync(join(box, "to-kiki"), { recursive: true });
    writeFileSync(f, body);
    old(f);
  };
  return { dataDir, pr, box, drop, delivered, answered };
}

test("message format: YAML header optional, .json also accepted", () => {
  assert.deepEqual(parseMessage("---\ntitle: Inspection\nre: \"abc\"\nattention: true\nbao: Work bot\n---\n\nBody"), {
    id: "",
    text: "Body",
    title: "Inspection",
    re: "abc",
    attention: true,
    bao: "Work bot",
  });
  assert.equal(parseMessage("Body only").text, "Body only");
  const c = parseMessage("---\nre: abc   # which one this replies to\nattention: true # needs a look\n---\nx");
  assert.equal(c.re, "abc");
  assert.equal(c.attention, true);
  assert.equal(parseMessage('{"text":"hi","attention":true}', true).attention, true);
});

test("create a mailbox folder and it connects; new messages queue up, go to Kiki, and the original file moves into done", async () => {
  const { pr, box, drop, delivered } = setup();
  writeFileSync(join(box, "status.json"), JSON.stringify({ state: "working", note: "step 3" }));
  drop("1.md", "---\ntitle: Daily report\nbao: Work bot\n---\ntoday's data");
  await pr.poll();
  await pr.settled();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /^@Work bot \[Mailroom\] external agent "grokbot" sent "Daily report"/);
  assert.ok(existsSync(join(box, "to-kiki", "done", "1.md")));
  const s = pr.state();
  assert.equal(s.agents[0].state, "working");
  assert.equal(s.recent[0].status, "routed");
  assert.equal(s.recent[0].routedTo, "→ Work bot/main chat · handed to bot");
  await pr.poll();
  await pr.settled(); // what's been taken won't be picked up again
  assert.equal(delivered.length, 1);
});

test("freshly written files are left alone so we don't read them half-written", async () => {
  const { pr, box, delivered } = setup();
  mkdirSync(join(box, "to-kiki"), { recursive: true });
  writeFileSync(join(box, "to-kiki", "new.md"), "still writing");
  await pr.poll();
  await pr.settled();
  assert.equal(delivered.length, 0);
});

test("assigning work writes to to-agent; a reply with re goes back to the assigning conversation, not through Kiki", async () => {
  const { pr, box, drop, delivered, answered } = setup();
  await pr.poll();
  await pr.settled();
  const sent = await pr.send("grokbot", "Look up the BTC price for me", "Check price", "/x/s.jsonl", "Work bot/Check price");
  const file = readFileSync(join(box, "to-agent", `${sent.id}.md`), "utf8");
  assert.match(file, /title: "Check price"/);
  assert.match(file, /from: "Work bot\/Check price"/);
  assert.equal(pr.state().agents[0].waiting, 1);
  drop("r.md", `---\nre: ${sent.id}\n---\n70k`);
  await pr.poll();
  await pr.settled();
  assert.deepEqual(answered, ["Check price:70k"]);
  assert.equal(delivered.length, 0);
  assert.equal(pr.outbox.get(sent.id)?.status, "answered");
  assert.equal(pr.state().agents[0].waiting, 0);
});

test("needs your attention: sender flagged attention, routing failed, sender errored; hidden after clicking ×", async () => {
  const { pr, box, drop } = setup();
  pr.deliver = async () => {
    throw new Error("model crashed");
  };
  writeFileSync(join(box, "status.json"), JSON.stringify({ state: "error", note: "login expired" }));
  drop("a.md", "---\nattention: true\ntitle: Payment due\n---\nrenewal");
  await pr.poll();
  await pr.settled();
  const att = pr.state().attention;
  assert.equal(att.length, 2);
  assert.equal(att[0].id, "agent:grokbot");
  assert.match(att[1].why, /not routed: model crashed/);
  pr.dismiss(att[1].id);
  assert.equal(pr.state().attention.length, 1);
});

test("queue persists to disk: still there after restart", async () => {
  const { dataDir, pr, drop } = setup();
  drop("1.txt", "hello");
  await pr.poll();
  await pr.settled();
  const again = new Postroom({ dataDir });
  assert.equal(again.inbox.rows.length, 1);
  assert.equal(again.inbox.rows[0].text, "hello");
});

test("unknown connection type: shows unreachable, assigning work errors", async () => {
  const { dataDir, pr } = setup();
  writeFileSync(join(dataDir, "postroom", "agents.json"), JSON.stringify([{ name: "x", kind: "smoke" }]));
  await pr.poll();
  const x = pr.state().agents.find((a) => a.name === "x");
  assert.equal(x?.state, "offline");
  assert.match(x?.note ?? "", /unknown/);
  await assert.rejects(pr.send("x", "hi"), /unknown/);
});

test("internal sources land in the same inbox: route false only notifies, doesn't route", async () => {
  const { pr, delivered } = setup();
  const notified: string[] = [];
  pr.notify = async (it) => void notified.push(`${it.from}:${it.title}`);
  pr.post("Background task", { title: "Weekly report done", text: "……", route: false });
  pr.post("Scheduled task", { title: "Time to drink water", text: "on time" });
  await pr.settled();
  assert.deepEqual(notified, ["Background task:Weekly report done"]);
  assert.equal(delivered.length, 1);
  assert.equal(pr.inbox.rows.find((r) => r.from === "Background task")?.status, "notified");
  assert.ok(pr.inbox.rows.every((r) => r.internal));
});

test("mailbox can live elsewhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-box-"));
  const a = new MailboxAgent("x", dir);
  assert.deepEqual(readdirSync(dir).sort(), ["to-agent", "to-kiki"]);
  assert.deepEqual(await a.status(), { state: "unknown" });
});

test("error or restart mid-read: not moved until persisted; unrouted ones resume routing after restart", async () => {
  const { dataDir, pr, box, drop, delivered } = setup();
  let release!: () => void;
  pr.deliver = () => new Promise((ok) => (release = () => ok("→ x")));
  drop("1.md", "first");
  await pr.poll();
  assert.ok(existsSync(join(box, "to-kiki", "done", "1.md"))); // moved only after persisting
  // routing still stuck (bot is answering); receiving is unaffected and won't deadlock
  drop("2.md", "second");
  await pr.poll();
  assert.equal(pr.inbox.rows.length, 2);
  // now "restart": both are still new, the new instance resumes routing on start
  const again = new Postroom({ dataDir });
  again.deliver = async (it) => {
    delivered.push(it.text);
    return "→ y";
  };
  again.start();
  again.stop();
  await again.settled();
  assert.deepEqual(delivered, ["first", "second"]);
  release();
});

test("run: assign work and wait for the reply (external executor for the task board); rejects when stopped", async () => {
  const { pr, drop, answered } = setup();
  await pr.poll();
  const p = pr.run("grokbot", "Check price", { title: "Check price" });
  await new Promise((r) => setTimeout(r, 20));
  const sent = pr.outbox.rows.at(-1)!;
  drop("r.md", `---\nre: ${sent.id}\n---\n70k`);
  await pr.poll();
  await pr.settled();
  assert.equal(await p, "70k");
  assert.deepEqual(answered, []); // result went to the waiting task, not recorded back to the conversation
  const ac = new AbortController();
  const q = pr.run("grokbot", "Stop it", { signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await assert.rejects(q, /stopped/);
  assert.equal(pr.outbox.rows.at(-1)!.status, "stopped");
});

test("read/unread: results written back to the assigning conversation; no alert if you have it open, alert if not, cleared once opened", async () => {
  const { pr, drop } = setup();
  const notified: string[] = [];
  pr.notify = async (it) => void notified.push(it.text);
  let open = new Set<string>(["/s/a.jsonl"]);
  pr.isViewing = (p) => open.has(p);
  await pr.poll();
  const a = await pr.send("grokbot", "one", "one", "/s/a.jsonl");
  const b = await pr.send("grokbot", "two", "two", "/s/b.jsonl");
  drop("ra.md", `---\nre: ${a.id}\n---\nreply one`);
  drop("rb.md", `---\nre: ${b.id}\n---\nreply two`);
  await pr.poll();
  await pr.settled();
  assert.deepEqual(notified, ["reply two"]); // a is open, only alert for b
  assert.equal(pr.state().unreadCount, 1);
  assert.equal(pr.state().unread[0].path, "/s/b.jsonl");
  pr.markRead(["/s/b.jsonl"]);
  assert.equal(pr.state().unreadCount, 0);
  // internal source: written into some conversation, route false
  open = new Set();
  pr.post("Background task", { title: "Done", text: "ok", route: false, path: "/s/c.jsonl" });
  await pr.settled();
  assert.equal(pr.state().unreadCount, 1);
  assert.equal(notified.length, 2);
});

test("key rules: sender flagged attention or matched your rule, alert on receipt (without waiting for Kiki), then route as usual", async () => {
  const { dataDir, pr, drop, delivered } = setup();
  writeFileSync(join(dataDir, "postroom", "key-rules.md"), "- from: boss\n- contains: /expir|payment/\n<!-- - contains: daily report -->\n");
  const notified: string[] = [];
  pr.notify = async (it) => void notified.push(`${it.urgent}|${it.title}`);
  drop("1.md", "---\ntitle: Domain about to expire\n---\n3 days left");
  drop("2.md", "---\ntitle: Daily report\n---\nall normal");
  await pr.poll();
  await pr.settled();
  assert.deepEqual(notified, ["matched rule \"contains: /expir|payment/\"|Domain about to expire"]);
  assert.equal(delivered.length, 2); // both still go to Kiki as usual
  pr.push("boss", { text: "Call me back" });
  await pr.settled();
  assert.match(notified[1], /from: boss/);
  assert.ok(!pr.inbox.rows.at(-1)!.internal);
});

test("a file dropped in the mailbox is picked up immediately, no waiting for the per-minute sweep", async () => {
  const { pr, box, delivered } = setup();
  await pr.poll(); // connect the mailbox, start watching the folder
  writeFileSync(join(box, "to-kiki", "now.md"), "urgent");
  // no manual poll: the mailbox checks every 2 seconds on its own. Wait up to 8 seconds
  for (let i = 0; i < 80 && !delivered.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    await pr.settled();
  }
  assert.equal(delivered.length, 1);
  pr.stop();
});

test("Kiki reads mail: unimportant ones just recorded without bothering the bot; important ones alerted; task-linked ones handed back to that conversation", async () => {
  const { pr, drop, delivered } = setup();
  const notified: string[] = [];
  const followed: string[] = [];
  pr.notify = async (it) => void notified.push(it.title ?? "");
  pr.followUp = async (s) => (followed.push(s), "handed back");
  const verdicts: any[] = [
    { important: false, route: false, crossed: [], follow: [] },
    { important: true, why: "charge failed", route: true, crossed: [], follow: [] },
    { important: false, route: false, crossed: [], follow: [{ text: "Hackathon signup", link: "Work bot/Signup" }] },
  ];
  pr.triage = async () => verdicts.shift();
  drop("1.md", "---\ntitle: Weekly report\n---\nroutine");
  drop("2.md", "---\ntitle: Bill\n---\ncharge failed");
  drop("3.md", "---\ntitle: Hackathon\n---\nplease submit missing materials");
  await pr.poll();
  await pr.settled();
  assert.equal(delivered.length, 1); // only the bill went to Kiki
  assert.deepEqual(followed, ["Work bot/Signup"]);
  assert.deepEqual(notified, ["Bill", "\"Hackathon signup\" has a new message"]);
  assert.equal(pr.inbox.rows.find((r) => r.title === "Weekly report")?.status, "triaged");
});

test("linked to a task card: hand back to the task to continue; if the task can't be reached, fall back to the handing-back conversation", async () => {
  const { pr, drop } = setup();
  const got: string[] = [];
  pr.notify = async () => {};
  pr.followTask = async (id) => (got.push(`task:${id}`), id === "t1" ? "" : undefined);
  pr.followUp = async (s) => (got.push(`session:${s}`), "handed back");
  pr.triage = async () => ({ important: false, route: false, crossed: [], follow: [{ text: "a", task: "t1" }, { text: "b", task: "t2", link: "bot/conversation" }] });
  drop("1.md", "progress");
  await pr.poll();
  await pr.settled();
  assert.deepEqual(got, ["task:t1", "task:t2", "session:bot/conversation"]);
});
