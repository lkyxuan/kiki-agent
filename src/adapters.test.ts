import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { A2AAgent } from "./a2a.js";
import { AcpAgent } from "./acp.js";
import type { AdapterContext, PermissionRequest } from "./postroom.js";
import { htmlText, parseFeed, WatchAgent } from "./watch.js";

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function ctx(asks: PermissionRequest[] = [], answer = true): AdapterContext {
  const dataDir = mkdtempSync(join(tmpdir(), "kiki-ad-"));
  const root = join(dataDir, "postroom");
  mkdirSync(root, { recursive: true });
  return { root, approve: async (r) => (asks.push(r), answer), wake: () => {} };
}

// ---------- A2A ----------

function fakeA2A(script: (method: string, params: any) => any) {
  const calls: string[] = [];
  const http = (async (url: string, init?: any) => {
    if (String(url).endsWith("/.well-known/agent-card.json")) return new Response(JSON.stringify({ name: "grok", url: "http://bot/rpc" }));
    const body = JSON.parse(init.body);
    calls.push(body.method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: script(body.method, body.params) }));
  }) as typeof fetch;
  return { http, calls };
}

test("A2A: dispatching doesn't wait for the result; later it finds the task done and hands back a reply tagged with re; after a restart it still remembers what it's waiting on", async () => {
  const c = ctx();
  let state = "working";
  const { http, calls } = fakeA2A((m) =>
    m === "message/send"
      ? { kind: "task", id: "t1", contextId: "c1", status: { state: "submitted" } }
      : { kind: "task", id: "t1", status: { state }, artifacts: [{ parts: [{ kind: "text", text: "BTC 70k" }] }] },
  );
  const a = new A2AAgent("grok", { name: "grok", kind: "a2a", url: "http://bot" }, c, http);
  await a.dispatch({ id: "o1", title: "Check price", text: "Check BTC" });
  assert.deepEqual(await a.status(), { state: "working", note: "1 in progress" });
  assert.deepEqual(await a.collect(), []);
  // A different instance (like Kiki restarting) keeps polling t1
  const b = new A2AAgent("grok", { name: "grok", kind: "a2a", url: "http://bot" }, c, http);
  state = "completed";
  const got = await b.collect();
  assert.equal(got.length, 1);
  assert.equal(got[0].re, "o1");
  assert.equal(got[0].text, "BTC 70k");
  assert.deepEqual(await b.status(), { state: "idle" });
  assert.deepEqual(calls, ["message/send", "tasks/get", "tasks/get"]);
});

test("A2A: if the other side needs a human reply, mark it as needing your attention; a direct message reply counts as done on the spot", async () => {
  const { http } = fakeA2A((_m, p) =>
    p.message.parts[0].text === "ask" ? { kind: "message", parts: [{ kind: "text", text: "answer" }] } : { kind: "task", id: "t2", status: { state: "input-required", message: { parts: [{ kind: "text", text: "Which coin?" }] } } },
  );
  const a = new A2AAgent("g", { name: "g", kind: "a2a", url: "http://bot" }, ctx(), http);
  await a.dispatch({ id: "o1", title: "x", text: "ask" });
  await a.dispatch({ id: "o2", title: "y", text: "Check price" });
  const got = await a.collect();
  assert.equal(got[0].text, "answer");
  assert.equal(got[1].attention, true);
  assert.match(got[1].text, /needs your reply[\s\S]*Which coin/);
});

test("A2A: if the agent card can't be read, treat it as unreachable", async () => {
  const a = new A2AAgent("g", { name: "g", kind: "a2a", url: "http://nope" }, ctx(), (async () => new Response("", { status: 404 })) as typeof fetch);
  assert.equal((await a.status()).state, "offline");
});

// ---------- ACP ----------

/** Fake ACP agent: reads JSON-RPC from stdin and replies in order. */
function fakeAcp(onPrompt: (send: (m: object) => void, id: number, sessionId: string) => void) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), exitCode: null, kill() {} }) as unknown as ChildProcess;
  const send = (m: object) => stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const replies: any[] = [];
  let buf = "";
  stdin.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (!m.method) replies.push(m);
      else if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1 } });
      else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s1" } });
      else if (m.method === "session/prompt") onPrompt(send, m.id, m.params.sessionId);
    }
  });
  return { launch: () => proc, replies };
}

test("ACP: spawn the process, open a session, collect text, and hand back a reply tagged with re when done", async () => {
  const { launch } = fakeAcp((send, id, sid) => {
    send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fixed it, " } } } });
    send({ method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "all tests pass" } } } });
    setTimeout(() => send({ id, result: { stopReason: "end_turn" } }), 5);
  });
  const a = new AcpAgent("cc", { name: "cc", kind: "acp", command: "fake" }, ctx(), launch);
  await a.dispatch({ id: "o1", title: "Fix bug", text: "Fix it" });
  assert.equal((await a.status()).state, "working");
  await tick(30);
  const got = await a.collect();
  assert.deepEqual(got.map((g) => [g.re, g.text]), [["o1", "Fixed it, all tests pass"]]);
  assert.equal((await a.status()).state, "idle");
});

test("ACP permission requests: ordinary commands are approved directly, delete-type ones go through an approval card (attached to the dispatching conversation)", async () => {
  const asks: PermissionRequest[] = [];
  const options = [
    { optionId: "yes", kind: "allow_once" },
    { optionId: "no", kind: "reject_once" },
  ];
  const { launch, replies } = fakeAcp((send, id, sid) => {
    send({ id: 100, method: "session/request_permission", params: { sessionId: sid, options, toolCall: { title: "Run tests", kind: "execute", rawInput: { command: "npm test" } } } });
    send({ id: 101, method: "session/request_permission", params: { sessionId: sid, options, toolCall: { title: "Clean directory", kind: "execute", rawInput: { command: "git reset --hard" } } } });
    setTimeout(() => send({ id, result: { stopReason: "end_turn" } }), 50);
  });
  const a = new AcpAgent("cc", { name: "cc", kind: "acp", command: "fake" }, ctx(asks, false), launch);
  await a.dispatch({ id: "o1", title: "t", text: "x", origin: "/s/a.jsonl" });
  await tick(300);
  const byId = Object.fromEntries(replies.map((r) => [r.id, r.result?.outcome?.optionId]));
  assert.equal(byId[100], "yes");
  assert.equal(byId[101], "no"); // approval was not granted
  assert.equal(asks.length, 1);
  assert.equal(asks[0].category, "delete");
  assert.equal(asks[0].origin, "/s/a.jsonl");
});

test("ACP: if neither preset nor command is set, fail with a clear error", () => {
  const a = new AcpAgent("cc", { name: "cc", kind: "acp" }, ctx());
  return assert.rejects(a.dispatch({ id: "o", title: "t", text: "x" }), /preset/);
});

// ---------- Watch ----------

test("Watch a file: the first check only records, afterwards only newly appeared lines are reported", async () => {
  const c = ctx();
  const f = join(c.root, "log.txt");
  writeFileSync(f, "a\nb\n");
  const w = new WatchAgent("Log", { name: "Log", kind: "watch", path: f }, c);
  assert.deepEqual(await w.collect(), []);
  assert.deepEqual(await w.collect(), []); // unchanged
  writeFileSync(f, "a\nb\nc failed\n");
  const got = await w.collect();
  assert.equal(got.length, 1);
  assert.match(got[0].text, /c failed$/);
  assert.doesNotMatch(got[0].text, /\nb\n/);
});

test("Watch a folder: each new file is reported separately; skipped if every hasn't elapsed", async () => {
  const c = ctx();
  const d = join(c.root, "drop");
  mkdirSync(d);
  writeFileSync(join(d, "old.md"), "old");
  const w = new WatchAgent("Downloads", { name: "Downloads", kind: "watch", path: d, every: 5, route: false }, c);
  const t0 = Date.now();
  assert.deepEqual(await w.collect(t0), []);
  writeFileSync(join(d, "new.md"), "new report");
  assert.deepEqual(await w.collect(t0 + 60_000), []); // only 1 minute passed
  const got = await w.collect(t0 + 6 * 60_000);
  assert.equal(got.length, 1);
  assert.equal(got[0].title, "new.md");
  assert.match(got[0].text, /new report/);
  assert.equal(got[0].route, false);
});

test("Watch RSS: only new entries are reported; web pages only yield text", async () => {
  const rss = (items: string[]) => `<?xml version="1.0"?><rss><channel>${items.map((t) => `<item><title><![CDATA[${t}]]></title><link>http://x/${t}</link><guid>${t}</guid></item>`).join("")}</channel></rss>`;
  let body = rss(["one"]);
  const http = (async () => new Response(body, { headers: { "content-type": "application/rss+xml" } })) as typeof fetch;
  const w = new WatchAgent("News", { name: "News", kind: "watch", url: "http://x/feed" }, ctx(), http);
  assert.deepEqual(await w.collect(), []);
  body = rss(["one", "two"]);
  const got = await w.collect();
  assert.deepEqual(got.map((g) => g.title), ["two"]);
  assert.match(got[0].text, /http:\/\/x\/two/);
  assert.equal(parseFeed("<html></html>"), undefined);
  assert.equal(htmlText("<html><script>x()</script><p>hello &amp; goodbye</p></html>"), "hello & goodbye");
});

test("Watch: if the address can't be opened, show an error", async () => {
  const w = new WatchAgent("x", { name: "x", kind: "watch", url: "http://x" }, ctx(), (async () => new Response("", { status: 500 })) as typeof fetch);
  await w.collect();
  assert.deepEqual((await w.status()).state, "error");
});
