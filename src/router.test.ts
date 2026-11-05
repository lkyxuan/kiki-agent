import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Registry } from "./registry.js";
import { parseDecision } from "./route.js";
import { type AgentBackend, Router } from "./router.js";

/** Fake pi layer. routeAnswer decides how the "routing model" answers: a string is returned as-is, null means the model failed. */
function setup() {
  let n = 0;
  const ctl = {
    routeAnswer: null as string | null,
    routePrompts: [] as string[],
    routeDelays: [] as number[], // delay (ms) for each routing call, taken in call order
    sends: [] as string[], // order in which send was called
    forks: [] as string[], // source of each fork
    notes: [] as string[], // messages reported back to the original conversation
    announced: [] as string[], // full answers announced to the UI
    duties: [] as string[], // newly created bots
  };
  const baos = ["dev", "life"];
  const backend: AgentBackend = {
    listAgents: () => [...baos],
    exists: (a) => baos.includes(a),
    createBao: (a, duty) => {
      baos.push(a);
      ctl.duties.push(`${a}:${duty}`);
    },
    create: async (a) => `/fake/${a}/${++n}.jsonl`,
    fork: async (a, from) => {
      ctl.forks.push(from);
      return `/fake/${a}/${++n}.jsonl`;
    },
    send: async (a, path, text) => {
      ctl.sends.push(text);
      return `[${path}] ${text}`;
    },
    isBusy: () => false,
    complete: async (_sys, user) => {
      ctl.routePrompts.push(user);
      const delay = ctl.routeDelays.shift() ?? 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (ctl.routeAnswer === null) throw new Error("no key");
      return ctl.routeAnswer;
    },
    describe: (a) => (a === "dev" ? "writes code" : "daily life"),
    recent: () => [],
    history: (path) => [{ role: "user", text: `ask ${path}` }, { role: "assistant", text: "answer" }],
    note: async (a, path, text) => void ctl.notes.push(`${path} ${text}`),
    announce: (path, text) => void ctl.announced.push(`${path} ${text}`),
  };
  const reg = new Registry(join(mkdtempSync(join(tmpdir(), "kiki-")), "registry.json"));
  const router = new Router(backend, reg, "life");
  const out: string[] = [];
  const say = (t: string) => router.handle("app", t, async (r) => void out.push(r));
  return { router, reg, out, say, ctl };
}

test("when the routing model is unavailable, hand off to the default bot's main chat", async () => {
  const { out, say, reg } = setup();
  await say("hello");
  assert.match(out[0], /^→ life\/main chat · handed to bot\n\n\[.*\] hello$/);
  assert.equal(reg.current("app")?.name, "main chat");
  await say("still there?");
  assert.match(out[1], /^→ life\/main chat · handed to bot/);
});

test("every bot automatically has a main chat; if the model says hand off to a bot (old new syntax), it goes into that bot's main chat, and Kiki does not open a thread", async () => {
  const { out, say, reg, ctl } = setup();
  ctl.routeAnswer = 'ok: {"action":"new","agent":"dev","name":"router","mode":"chat"}';
  await say("help me design routing");
  assert.match(out[0], /^→ dev\/main chat · handed to bot/);
  assert.deepEqual(reg.list().map((x) => `${x.agent}/${x.name}`).sort(), ["dev/main chat", "life/main chat"]);
  assert.match(ctl.routePrompts[0], /- dev\/main chat/);
});

test("model says keep chatting: go into the specified conversation, and the prompt marks the current conversation", async () => {
  const { out, say, ctl } = setup();
  await say("/new dev router");
  await say("/new life fitness");
  ctl.routeAnswer = '{"action":"continue","target":"dev/router","mode":"chat"}';
  await say("tweak the routing part again");
  assert.match(out.at(-1)!, /^→ dev\/router · continued/);
  assert.match(ctl.routePrompts.at(-1)!, /life\/fitness\[current\]/);
});

test("model gave a nonexistent conversation: don't create one, fall back to the current conversation", async () => {
  const { out, say, ctl } = setup();
  await say("/new dev router");
  ctl.routeAnswer = '{"action":"continue","target":"dev/made-up","mode":"chat"}';
  await say("mm");
  assert.match(out.at(-1)!, /^→ dev\/router · continued/);
});

test("model gave options but we don't ask the user back: just take the first one", async () => {
  const { out, say, ctl, reg } = setup();
  await say("/new dev router");
  ctl.routeAnswer = '{"action":"ask","options":[{"target":"life/main chat"},{"target":"dev/router"}],"reason":"both fit"}';
  await say("should I upgrade the RAM on the Mac mini");
  assert.match(out.at(-1)!, /^→ life\/main chat · handed to bot\n\n\[.*\] should I upgrade the RAM on the Mac mini$/);
  assert.equal(reg.current("app")?.agent, "life");
});

test("@botname only picks within that bot; if the model goes out of bounds, fall back to that bot's main chat", async () => {
  const { out, say, ctl } = setup();
  await say("/new life fitness");
  ctl.routeAnswer = '{"action":"continue","target":"life/fitness","mode":"chat"}';
  await say("@dev take a look at this error");
  assert.match(out.at(-1)!, /^→ dev\/main chat · handed to bot\n\n\[.*\] take a look at this error$/);
  assert.match(ctl.routePrompts.at(-1)!, /may only continue or new under it/);
});

test("/to redirects the previous message elsewhere", async () => {
  const { out, say } = setup();
  await say("going hiking this weekend"); // goes into life/default
  await say("/to dev misc");
  assert.match(out.at(-1)!, /^→ dev\/misc · opened\n\n\[.*\] going hiking this weekend$/);
});

test("judged as background: hand off to a background task, ack first, report back to the inbox and the original conversation when done, and don't change the current conversation", async () => {
  const { out, say, reg, ctl, router } = setup();
  await say("/new dev mainline");
  ctl.routeAnswer = '{"action":"continue","target":"dev/mainline","mode":"background","taskTitle":"tidy README"}';
  await say("tidy up the README");
  await new Promise((r) => setTimeout(r, 10));
  assert.match(out.at(-2)!, /^→ dev · Background task "tidy README"\n\nOkay, handed to the background; I'll report back when it's done here and in dev\/mainline/);
  assert.match(out.at(-1)!, /^✅ Background task "tidy README" completed \(\[bg-tidy README\]\(kiki:dev\/bg-tidy README\)\):\n\n.*tidy up the README/s);
  assert.equal(reg.current("app")?.name, "mainline");
  const main = reg.get("dev", "mainline")!;
  assert.match(ctl.notes.at(-1)!, new RegExp(`^${main.path} ✅ Background task "tidy README" completed`));
  assert.equal(router.tasks.list()[0].status, "done");
});

test("continuing from a conversation judged as background: fork that conversation, and the background task carries the context", async () => {
  const { out, say, reg, ctl } = setup();
  await say("/new dev design");
  const src = reg.current("app")!.path;
  ctl.routeAnswer = '{"action":"continue","target":"dev/design","mode":"background","taskTitle":"implement"}';
  await say("implement it per the design we just discussed");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ctl.forks, [src]);
  assert.match(out.at(-1)!, /✅ Background task "implement" completed \(\[bg-implement\]\(kiki:dev\/bg-implement\)\)/);
});

test("work handed to a bot judged as background: don't fork the main chat, just start a task", async () => {
  const { out, say, reg, ctl } = setup();
  ctl.routeAnswer = '{"action":"new","agent":"dev","name":"weekly report","mode":"background","taskTitle":"write weekly report"}';
  await say("help me write this week's report");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(reg.list().map((s) => s.name).filter((n) => n !== "main chat"), ["bg-write weekly report"]);
  assert.deepEqual(ctl.forks, []);
  assert.match(out.at(-1)!, /✅ Background task "write weekly report" completed/);
  assert.equal(ctl.notes.length, 0);
});

test("when there are more than 20 conversations, the current conversation is still among the candidates, and keep chatting isn't rejected", async () => {
  const { out, say, ctl } = setup();
  await say("/new dev old conversation");
  for (let i = 0; i < 25; i++) await say(`/new dev new${i}`);
  await say("/use dev/old conversation");
  ctl.routeAnswer = '{"action":"continue","target":"dev/old conversation","mode":"chat"}';
  await say("continue");
  assert.match(ctl.routePrompts.at(-1)!, /dev\/old conversation\[current\]/);
  assert.match(out.at(-1)!, /^→ dev\/old conversation · continued/);
});

test("two messages sent in a row in the same chat: the first one enters the conversation first, even if the first message routes slower", async () => {
  const { router, ctl } = setup();
  ctl.routeDelays = [30, 0];
  const out: string[] = [];
  const r = async (x: string) => void out.push(x);
  await Promise.all([router.handle("app", "first message", r), router.handle("app", "second message", r)]);
  assert.deepEqual(ctl.sends, ["first message", "second message"]);
});

test("/bg forces background (forks the current conversation), /tasks lists, /retry reruns", async () => {
  const { out, say, reg, router } = setup();
  await say("/new dev mainline");
  await say("/bg tidy up the README");
  await new Promise((r) => setTimeout(r, 10));
  assert.match(out.at(-2)!, /handed to the background/);
  assert.match(out.at(-1)!, /✅ Background task "tidy up the README" completed/);
  assert.ok(reg.list().find((s) => s.background));
  await say("/tasks");
  assert.match(out.at(-1)!, /^\[Done\] tidy up the README · dev · /);
  const id = router.tasks.list()[0].id;
  await say(`/retry ${id}`);
  assert.match(out.at(-1)!, /starting over/);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(router.tasks.list().length, 2);
  assert.ok(reg.get("dev", "bg-tidy up the README2"), "a rerun opens a new background conversation, not mixed with the old one");
});

test("/new /use /list manual commands still work as usual", async () => {
  const { out, say, reg } = setup();
  await say("/new dev misc");
  await say("/new life misc");
  await say("/use misc");
  assert.match(out.at(-1)!, /Duplicate names/);
  await say("/use dev/misc");
  assert.equal(reg.current("app")?.agent, "dev");
  await say("/list");
  assert.match(out.at(-1)!, /👉 dev\/misc/);
});

test("parseDecision filters out invalid output", () => {
  const valid = { agents: ["dev"], targets: ["dev/a", "dev/main chat"] };
  assert.equal(parseDecision("not JSON", valid), undefined);
  assert.equal(parseDecision('{"action":"new","agent":"nope","name":"x"}', valid), undefined);
  assert.deepEqual(parseDecision('{"action":"ask","options":[{"target":"dev/a"},{"target":"dev/zz"}]}', valid), {
    action: "continue",
    target: "dev/a",
    mode: "chat",
    taskTitle: undefined,
    reason: undefined,
  });
  const d = parseDecision('{"action":"new","agent":"dev","name":"x","mode":"background","taskTitle":"t"}', valid);
  assert.deepEqual(d, { action: "continue", target: "dev/main chat", mode: "background", taskTitle: "t", reason: undefined });
});

test("handoff (chat): open a new conversation, the first message is the handoff note, duplicate names get a number", async () => {
  const { router, say, reg, ctl } = setup();
  await say("/new dev mainline");
  const from = reg.current("app")!.path;
  const r = await router.handoff({ fromPath: from, bao: "life", name: "buy computer", brief: "【goal】pick a Mac", mode: "chat" });
  assert.match(r, /handed off to life\/buy computer/);
  await new Promise((x) => setTimeout(x, 5));
  assert.match(ctl.sends.at(-1)!, /handed off from "dev\/mainline".*\n\n【goal】pick a Mac\n\nFirst say in one sentence what you understand the goal to be, then continue the conversation directly/s);
  assert.match(ctl.announced.at(-1)!, /handed off/, "the new conversation's answer must be announced to the UI to wrap up");
  await router.handoff({ fromPath: from, bao: "life", name: "buy computer", brief: "x", mode: "chat" });
  assert.ok(reg.get("life", "buy computer2"));
  assert.equal(reg.current("app")!.path, from, "handoff doesn't change the current conversation");
});

test("handing off to a nonexistent bot errors", async () => {
  const { router } = setup();
  await assert.rejects(router.handoff({ fromPath: undefined, bao: "nope", name: "x", brief: "x", mode: "chat" }), /no bot/);
});

test("handoff (background): start a clean new conversation per the brief, don't fork the original, report back to the original when done", async () => {
  const { router, say, reg, ctl } = setup();
  await say("/new dev mainline");
  const from = reg.current("app")!.path;
  const r = await router.handoff({ fromPath: from, bao: "dev", name: "write script", brief: "【goal】write a backup script", mode: "background" });
  assert.match(r, /background task "write script"/);
  await new Promise((x) => setTimeout(x, 30));
  assert.deepEqual(ctl.forks, []);
  assert.match(ctl.sends.at(-1)!, /【goal】write a backup script\n\nPlease start working right away/);
  assert.match(ctl.notes.at(-1)!, new RegExp(`^${from} ✅ Background task "write script" completed`));
});

test("kiki_peek: list all conversations; view the last few of a conversation; when not found, list the existing ones", async () => {
  const { router, say } = setup();
  await say("/new dev router");
  assert.match(router.peek(undefined, 10), /## dev \(writes code\)\n- dev\/router\n## life \(daily life\)/);
  assert.match(router.peek("dev/router", 10), /^dev\/router most recent 2 of 2 messages:\n\nUser: ask .*\n\nAssistant: answer$/);
  assert.match(router.peek("router", 1), /most recent 1/);
  assert.throws(() => router.peek("dev/none", 5), /Conversation "dev\/none" not found. Existing: dev\/router/);
});

test("kiki_relay: pass a message to another conversation, the answer is recorded back to the originating conversation; can't relay to yourself", async () => {
  const { router, say, reg, ctl } = setup();
  await say("/new dev router");
  const a = reg.current("app")!.path;
  await say("/new life buy computer");
  const b = reg.current("app")!.path;
  const r = await router.relay(b, "dev/router", "budget set at 8000");
  assert.match(r, /Relayed to dev\/router/);
  await new Promise((res) => setTimeout(res, 10));
  assert.match(ctl.sends.at(-1)!, /^\[Message relayed from "life\/buy computer"\]\nbudget set at 8000/);
  assert.ok(ctl.announced.some((x) => x.startsWith(a)));
  assert.match(ctl.notes.at(-1)!, new RegExp(`^${b} \\[Reply from dev/router\\]`));
  await assert.rejects(router.relay(b, "life/buy computer", "x"), /current conversation/);
});

test("handoff: handing off same-named things at the same time, each gets a different name", async () => {
  const { router, reg } = setup();
  const [a, b] = await Promise.all([
    router.handoff({ fromPath: undefined, bao: "life", name: "buy computer", brief: "x", mode: "chat" }),
    router.handoff({ fromPath: undefined, bao: "life", name: "buy computer", brief: "y", mode: "chat" }),
  ]);
  assert.match(a, /life\/buy computer;/);
  assert.match(b, /life\/buy computer2;/);
  assert.deepEqual(reg.list("life").map((s) => s.name).sort(), ["buy computer", "buy computer2"]);
});

test("feature toggles: turning off auto-routing sends into the current conversation; turning off background treats it as chat", async () => {
  const { router, out, say, ctl } = setup();
  await say("/new dev router");
  const off = new Set<string>(["route"]);
  router.isOn = (id) => !off.has(id);
  ctl.routeAnswer = '{"action":"new","agent":"life","name":"buy computer","mode":"chat"}';
  const before = ctl.routePrompts.length;
  await say("Just saying something");
  assert.equal(ctl.routePrompts.length, before);
  assert.match(out.at(-1)!, /^→ dev\/router · continued/);
  off.clear();
  off.add("background");
  ctl.routeAnswer = '{"action":"continue","target":"dev/路由器","mode":"background","taskTitle":"跑测试"}';
  await say("Go run the tests");
  assert.match(out.at(-1)!, /^→ dev\/router · continued/);
  const r = await router.handoff({ fromPath: undefined, bao: "life", name: "写脚本", brief: "x", mode: "background" });
  assert.match(r, /handed off to life\/写脚本/);
});

test("No suitable bot: routing creates a new bot and hands it to its main chat", async () => {
  const { out, say, ctl, reg } = setup();
  ctl.routeAnswer = '{"action":"new","agent":"购物宝","newBao":"买东西：比价、选型","name":"选iPad","mode":"chat"}';
  await say("Pick out an iPad for my mom");
  assert.deepEqual(ctl.duties, ["购物宝:买东西：比价、选型"]);
  assert.match(out.at(-1)!, /^→ 购物宝\/main chat · created bot/);
  assert.equal(reg.current("app")?.agent, "购物宝");
});

test("Invalid new bot name or @-mentioning a bot: don't create, fall back to default", async () => {
  const { out, say, ctl } = setup();
  ctl.routeAnswer = '{"action":"new","agent":"a/b","newBao":"x","name":"y","mode":"chat"}';
  await say("Whatever");
  assert.deepEqual(ctl.duties, []);
  assert.match(out.at(-1)!, /^→ life\/main chat/);
  ctl.routeAnswer = '{"action":"new","agent":"购物宝","newBao":"x","name":"y","mode":"chat"}';
  await say("@dev whatever");
  assert.deepEqual(ctl.duties, []);
});

test("Something answerable in one line: Kiki answers directly, no conversation entered", async () => {
  const { out, say, ctl, reg } = setup();
  ctl.routeAnswer = '{"action":"reply","text":"Hi there!","reason":"打招呼"}';
  await say("Hello");
  assert.equal(out.at(-1), "Kiki · direct answer\n\nHi there!");
  assert.match(ctl.routePrompts.at(-1)!, /^Now: .*\d{4}.*\(.+\)\n/); // include the time so "what time is it" gets the right answer
  assert.equal(ctl.sends.length, 0);
  assert.equal(reg.current("app"), undefined);
});

test("Handing off to a bot that doesn't exist yet: create it if duty is given, error otherwise", async () => {
  const { router, ctl } = setup();
  await assert.rejects(router.handoff({ fromPath: undefined, bao: "生活宝", name: "买iPad", brief: "x", mode: "chat" }), /to create one, also fill in duty/);
  const r = await router.handoff({ fromPath: undefined, bao: "生活宝", duty: "日常生活", name: "买iPad", brief: "x", mode: "chat" });
  assert.match(r, /^created bot "生活宝", handed off to 生活宝\/买iPad/);
  assert.deepEqual(ctl.duties, ["生活宝:日常生活"]);
});

test("One message split into several items: one goes into an existing thread, one creates a new bot handed to its main chat, each gets its own brief, and Kiki replies with a list with cards", async () => {
  const { out, say, ctl, reg } = setup();
  await say("/new dev Router");
  ctl.routeAnswer = JSON.stringify({
    action: "split",
    parts: [
      { action: "continue", target: "dev/路由器", mode: "chat", text: "路由要支持拆分" },
      { action: "new", agent: "生活宝", newBao: "日常生活", name: "选iPad", mode: "chat", text: "给妈妈选 iPad，预算 3000" },
      { action: "new", agent: "瞎编", name: "x", mode: "chat", text: "不合法，丢掉" },
    ],
  });
  await say("Routing needs to support splitting; also help me pick an iPad for my mom, budget 3000");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(
    out.at(-1),
    "Kiki · split into 2 items, dispatched separately\n\n- [路由器](kiki:dev/路由器): continued\n- [生活宝](kiki:生活宝/main chat): created bot",
  );
  assert.deepEqual(ctl.duties, ["生活宝:日常生活"]);
  assert.deepEqual(ctl.sends.slice(-2).sort(), ["给妈妈选 iPad，预算 3000", "路由要支持拆分"]);
  assert.equal(ctl.announced.length, 2);
  assert.equal(reg.current("app")?.name, "Router");
});

test("Split leaves only one valid item: treat as a normal dispatch, hand over the user's original words", async () => {
  const { out, say, ctl } = setup();
  ctl.routeAnswer = JSON.stringify({
    action: "split",
    parts: [
      { action: "new", agent: "life", name: "买菜", mode: "chat", text: "买菜" },
      { action: "continue", target: "dev/不存在", mode: "chat", text: "x" },
    ],
  });
  await say("Help me make a grocery list");
  assert.match(out.at(-1)!, /^→ life\/main chat · handed to bot\n\n\[.*\] Help me make a grocery list$/);
  assert.equal(ctl.sends.at(-1), "Help me make a grocery list");
});

test("Concurrent main-chat creation doesn't create two with the same name", async () => {
  const { router, reg } = setup();
  await Promise.all([router.ensureMains(), router.ensureMains(), router.ensureMain("dev")]);
  assert.deepEqual(reg.list().map((x) => `${x.agent}/${x.name}`).sort(), ["dev/main chat", "life/main chat"]);
});

test("Background work handed to the main chat in a split doesn't fork the main chat", async () => {
  const { say, ctl } = setup();
  ctl.routeAnswer = JSON.stringify({
    action: "split",
    parts: [
      { action: "continue", target: "dev/主对话", mode: "background", taskTitle: "跑测试", text: "跑一遍测试" },
      { action: "continue", target: "life/主对话", mode: "chat", text: "买菜" },
    ],
  });
  await say("Run the tests; and grab groceries while you're at it");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ctl.forks, []);
});

test("Delete thread: remove from registry, disconnect chats attached to it, hand to backend to move to Trash; main chat can't be deleted", async () => {
  const { router, reg } = setup();
  const discarded: string[] = [];
  (router as any).agents.discard = async (_a: string, p: string) => void discarded.push(p);
  const t = await router.newSession("dev", "Fix bug");
  reg.setCurrent("app", t.path);
  await router.deleteSession(t.path);
  assert.equal(reg.byPath(t.path), undefined);
  assert.equal(reg.current("app"), undefined);
  assert.deepEqual(discarded, [t.path]);
  const main = await router.ensureMain("dev");
  await assert.rejects(router.deleteSession(main.path), /can't be deleted/);
  await assert.rejects(router.deleteSession("/nope"), /No such conversation/);
});

test("Clear main chat: swap in a new file, name unchanged, chats attached to it follow", async () => {
  const { router, reg } = setup();
  const discarded: string[] = [];
  (router as any).agents.discard = async (_a: string, p: string) => void discarded.push(p);
  const main = await router.ensureMain("dev");
  const old = main.path;
  reg.setCurrent("app", old);
  const rec = await router.clearMain(old);
  assert.notEqual(rec.path, old);
  assert.equal(reg.get("dev", "main chat")?.path, rec.path);
  assert.equal(reg.current("app")?.path, rec.path);
  assert.deepEqual(discarded, [old]);
  const t = await router.newSession("dev", "Discussion");
  await assert.rejects(router.clearMain(t.path), /Only the main chat/);
});

test("kiki_relay with only a bot name: hand to that bot's main chat", async () => {
  const { router, say, reg, ctl } = setup();
  await router.ensureMains();
  await say("/new dev Router");
  const from = reg.current("app")!.path;
  const r = await router.relay(from, "life", "User asks: where should we go this weekend");
  assert.match(r, /Relayed to life\/main chat/);
  await new Promise((x) => setTimeout(x, 10));
  assert.match(ctl.sends.at(-1)!, /^\[Message relayed from "dev\/Router"\]\nUser asks: where should we go this weekend/);
});

test("Kiki routing only sees summaries: each bot's main chat + 5 most recent + current conversation, older ones just counted", async () => {
  const { router, reg, say, ctl } = setup();
  await router.ensureMains();
  const recs = [];
  for (let i = 1; i <= 8; i++) recs.push(await router.newSession("dev", `Thread ${i}`));
  recs.forEach((r, i) => reg.setSummary(r.path, `Summary of thread ${i + 1}`, new Date(2026, 0, 1, 0, i)));
  reg.setCurrent("app", recs[0].path); // the oldest thread is the current conversation, it must be included too
  ctl.routeAnswer = '{"action":"continue","target":"dev/串8","mode":"chat"}';
  await say("Keep going");
  const p = ctl.routePrompts.at(-1)!;
  assert.match(p, /dev\/Thread 8: Summary of thread 8/);
  assert.match(p, /dev\/Thread 4: Summary of thread 4/);
  assert.doesNotMatch(p, /dev\/串3/);
  assert.match(p, /dev\/Thread 1\[current\]: Summary of thread 1/);
  assert.match(p, /2 more older threads/);
  assert.match(p, /dev\/main chat/);
});

test("Main chat's thread list: most recently active first, with summaries and card syntax", async () => {
  const { router, reg } = setup();
  assert.equal(router.threadDigest("dev"), "");
  await router.ensureMains();
  const a = await router.newSession("dev", "Fix bug");
  const b = await router.newSession("dev", "Write docs");
  reg.setSummary(a.path, "Login page error, cause found", new Date(2026, 0, 1, 10));
  reg.setSummary(b.path, "README half written", new Date(2026, 0, 1, 9));
  const d = router.threadDigest("dev");
  assert.ok(d.indexOf("Fix bug") < d.indexOf("Write docs"));
  assert.match(d, /\[Fix bug\]\(kiki:dev\/Fix bug\): Login page error, cause found/);
  assert.doesNotMatch(d, /main chat\]/);
});

test("Clearing the main chat also clears its summary", async () => {
  const { router, reg } = setup();
  (router as any).agents.discard = async () => {};
  const main = await router.ensureMain("dev");
  reg.setSummary(main.path, "Old summary");
  const rec = await router.clearMain(main.path);
  assert.equal(reg.byPath(rec.path)?.summary, undefined);
});

test("Background task stuck: inbox explains where it's stuck, /answer finishes it", async () => {
  const { out, say, router } = setup();
  await say("/new dev Main line");
  const orig = (router.tasks as any).backend.send;
  (router.tasks as any).backend.send = async (a: string, p: string, text: string) => {
    if (text === "整理周报") router.tasks.ask(p, "Which project should I focus on?");
    return orig(a, p, text);
  };
  await say("/bg 整理周报");
  await new Promise((r) => setTimeout(r, 10));
  assert.match(out.at(-1)!, /⏸ Background task "整理周报" is missing something and is waiting on you.*\n\nWhich project should I focus on?\n\n.*\/answer /s);
  const id = router.tasks.list()[0].id;
  await say(`/answer ${id} Kiki`);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(out.at(-1)!, /✅ Background task "整理周报" completed/);
  await say("/tasks");
  assert.match(out.at(-1)!, /\[Done\] 整理周报/);
});

test("Routing recognizes \"change that task\": hand to that task, task list goes into the prompt", async () => {
  const { out, say, ctl, router } = setup();
  const t = router.tasks.start({ agent: "dev", title: "周报", prompt: "写周报", hold: true });
  ctl.routeAnswer = JSON.stringify({ action: "task", id: t.id, text: "加上下周计划" });
  await say("Add next week's plan to the weekly report");
  assert.match(ctl.routePrompts.at(-1)!, new RegExp(`## Background tasks\\n- ${t.id} "周报" dev · To do`));
  assert.match(out.at(-1)!, /^→ background task "周报"\n\n/);
  assert.match(router.tasks.get(t.id)!.prompt, /加上下周计划$/);
});

test("When judged as background, include done criteria; main chat sees the task count", async () => {
  const { say, ctl, router } = setup();
  ctl.routeAnswer = '{"action":"new","agent":"dev","name":"周报","mode":"background","taskTitle":"写周报","doneWhen":"三段，每段一句"}';
  await say("Help me write the weekly report");
  assert.equal(router.tasks.list()[0].doneWhen, "三段，每段一句");
  router.tasks.start({ agent: "dev", title: "回头", prompt: "p", hold: true });
  assert.match(router.taskCount(), /to do and scheduled 1/);
  assert.equal(router.taskCount("life"), "");
});
