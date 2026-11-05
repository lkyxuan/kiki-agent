import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Coders, normalize, resumeCommand } from "./coders.js";
import { CoderSetup, claudeInstalled, codexInstalled, hookScript, mergeClaude, mergeCodex, unmergeClaude, unmergeCodex } from "./coders-setup.js";
import { addSetupBao, SETUP_BAO } from "./migrate.js";

const tmp = () => mkdtempSync(join(tmpdir(), "kiki-coders-"));
const make = (o: Partial<ConstructorParameters<typeof Coders>[0]> = {}) =>
  new Coders({ dataDir: tmp(), listBaos: () => ["Kiki", "kiki", "Life"], defaultBao: "Kiki", ...o });
const cc = (event: string, extra: Record<string, unknown> = {}) => ({ session_id: "s1", cwd: "/Users/me/code/kiki", transcript_path: "/t.jsonl", hook_event_name: event, ...extra });

test("Claude Code: start → prompt → wait for approval → resume → done → close, status follows along", async () => {
  const c = make();
  await c.ingest("claude-code", cc("SessionStart"));
  let s = c.list()[0];
  assert.equal(s.bao, "kiki"); // folder name matches bot name
  assert.equal(s.status, "idle");
  await c.ingest("claude-code", cc("UserPromptSubmit", { prompt: "Fix the login page\nDetails..." }));
  s = c.list()[0];
  assert.equal(s.status, "running");
  assert.equal(s.title, "Fix the login page");
  await c.ingest("claude-code", cc("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }));
  assert.equal(c.list()[0].status, "waiting");
  assert.equal(c.list()[0].waitingFor, "approval");
  await c.ingest("claude-code", cc("PostToolUse", { tool_name: "Bash" }));
  assert.equal(c.list()[0].status, "running");
  await c.ingest("claude-code", cc("Stop", { last_assistant_message: "All fixed, tests pass." }));
  s = c.list()[0];
  assert.equal(s.status, "idle");
  assert.equal(s.summary, "All fixed, tests pass.");
  assert.equal(s.turns.length, 1);
  assert.ok(s.turns[0].done);
  await c.ingest("claude-code", cc("SessionEnd", { reason: "prompt_input_exit" }));
  assert.equal(c.list()[0].status, "ended");
  c.save();
  assert.ok(existsSync(join(c.dir, "sessions.json")));
});

test("Codex: a single notify carries both the prompt and the result", async () => {
  const c = make();
  await c.ingest("codex", { type: "agent-turn-complete", "thread-id": "t1", "turn-id": "u1", cwd: "/x/trip-plan", "input-messages": ["Book a hotel in Tokyo"], "last-assistant-message": "Found three, see hotels.md" });
  const s = c.list()[0];
  assert.equal(s.tool, "codex");
  assert.equal(s.title, "Book a hotel in Tokyo");
  assert.equal(s.status, "idle");
  assert.equal(s.bao, "Kiki"); // no match, and no model either: goes to the default bot
  assert.match(resumeCommand(s), /^cd \/x\/trip-plan && codex resume t1$|^cd '\/x\/trip-plan' && codex resume t1$/);
});

test("When the first two events of the same session arrive together, only one card is created", async () => {
  const c = make({ pickBao: async () => (await new Promise((r) => setTimeout(r, 20)), "Life") });
  await Promise.all([c.ingest("claude-code", cc("SessionStart", { cwd: "/p/x" })), c.ingest("claude-code", cc("UserPromptSubmit", { cwd: "/p/x", prompt: "Do the thing" }))]);
  assert.equal(c.list().length, 1);
  assert.equal(c.list()[0].status, "running");
});

test("Events we don't care about, and tool calls with no session start, create no card", async () => {
  assert.equal(normalize("claude-code", cc("PreCompact")), undefined);
  assert.equal(normalize("claude-code", cc("Notification", { notification_type: "auth_success" })), undefined);
  assert.equal(normalize("whatever", cc("Stop")), undefined);
  const c = make();
  assert.equal(await c.ingest("claude-code", cc("PostToolUse")), undefined);
  assert.equal(c.list().length, 0);
});

test("Folders belong to bots: the model picks once and it's remembered, subfolders follow, and it can be reassigned", async () => {
  let asked = 0;
  const c = make({ pickBao: async () => (asked++, "Life") });
  await c.ingest("claude-code", cc("UserPromptSubmit", { cwd: "/p/trip", prompt: "Plan the itinerary" }));
  await c.ingest("claude-code", cc("UserPromptSubmit", { session_id: "s2", cwd: "/p/trip/sub", prompt: "Take another look" }));
  assert.equal(asked, 1);
  assert.deepEqual(c.list().map((s) => s.bao), ["Life", "Life"]);
  c.setBao("/p/trip", "kiki");
  assert.deepEqual(c.list().map((s) => s.bao), ["kiki", "kiki"]);
  assert.throws(() => c.setBao("/p/trip", "no-such-bot"));
});

test("After a turn, a small model condenses it to one line; the main chat digest and briefing include it", async () => {
  const c = make({ summarize: async () => "Login page fixed, all tests pass" });
  await c.ingest("claude-code", cc("UserPromptSubmit", { prompt: "Fix the login page" }));
  await c.ingest("claude-code", cc("Stop", { last_assistant_message: "a very long answer".repeat(30) }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(c.list()[0].summary, "Login page fixed, all tests pass");
  assert.match(c.digest("kiki"), /Claude Code · kiki: turn finished · Fix the login page → Login page fixed/);
  assert.equal(c.digest("Life"), "");
  assert.match(c.briefingLines().done[0], /finished 1 turn in kiki/);
});

test("Spool written by the hook while Kiki is closed is picked up on startup", async () => {
  const c = make();
  writeFileSync(join(c.dir, "spool", "pending.jsonl"), [JSON.stringify({ tool: "claude-code", host: "mbp", at: "2026-11-03T10:00:00Z", event: cc("UserPromptSubmit", { prompt: "picked up later" }) }), "bad line", ""].join("\n"));
  assert.equal(await c.drainSpool(), 1);
  assert.equal(c.list()[0].title, "picked up later");
  assert.equal(c.list()[0].host, "mbp");
  assert.equal(await c.drainSpool(), 0);
});

test("Installing the Claude Code hook: no duplicates, leaves existing hooks alone, can be removed", () => {
  const orig = JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } });
  const once = mergeClaude(orig, "/d/kiki-hook.sh");
  assert.ok(claudeInstalled(once));
  assert.equal(mergeClaude(once, "/d/kiki-hook.sh"), once);
  const cfg = JSON.parse(once);
  assert.equal(cfg.model, "opus");
  assert.equal(cfg.hooks.Stop.length, 2);
  assert.equal(cfg.hooks.Stop[1].hooks[0].async, true);
  const back = JSON.parse(unmergeClaude(once));
  assert.deepEqual(back, JSON.parse(orig));
  assert.ok(!claudeInstalled(""));
  assert.throws(() => mergeClaude("{bad", "/d/kiki-hook.sh"));
});

test("Installing the Codex notify: chains onto an existing one and restores it on removal", () => {
  const empty = mergeCodex('model = "o3"\n[profiles.x]\nnotify = "not top-level"\n', "/d/kiki-hook.sh");
  assert.equal(empty.prev, undefined);
  assert.match(empty.text, /^notify = \["\/d\/kiki-hook.sh","codex"\]\nmodel/);
  assert.ok(codexInstalled(empty.text));
  assert.equal(unmergeCodex(empty.text), 'model = "o3"\n[profiles.x]\nnotify = "not top-level"\n');

  const had = mergeCodex("notify = ['python3', '/n.py']\nmodel = \"o3\"\n", "/d/kiki-hook.sh");
  assert.deepEqual(had.prev, ["python3", "/n.py"]);
  assert.equal(unmergeCodex(had.text, had.prev), 'notify = ["python3","/n.py"]\nmodel = "o3"\n');
  assert.throws(() => mergeCodex("notify = [\n 'a',\n]\n", "/d/kiki-hook.sh"));
});

test("CoderSetup: local toggles back up files and write the script", () => {
  const home = tmp(), data = tmp();
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  const s = new CoderSetup({ dataDir: data, port: 4567, home });
  assert.deepEqual([s.status().claude.on, s.status().claude.found, s.status().codex.found], [false, true, false]);
  assert.match(s.set("claude", true), /Connected/);
  assert.ok(s.status().claude.on);
  assert.ok(existsSync(join(home, ".claude", "settings.json.kiki-bak")));
  assert.match(readFileSync(s.script, "utf8"), /127\.0\.0\.1:4567/);
  assert.match(s.set("claude", true), /Already connected/);
  s.set("claude", false);
  assert.ok(!s.status().claude.on);
});

test("Hook script: send if it goes through, otherwise spool it and flush next time it does", async () => {
  const got: { url: string; body: string }[] = [];
  let up = false;
  const srv = createServer(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    if (!up) { res.writeHead(503); return res.end(); }
    got.push({ url: req.url!, body: b });
    res.end("{}");
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  const port = (srv.address() as any).port;
  const dir = tmp();
  const script = join(dir, "kiki-hook.sh");
  writeFileSync(script, hookScript({ url: `http://127.0.0.1:${port}`, spool: join(dir, "spool") }), { mode: 0o755 });
  // The server is in the same process, so the script must run asynchronously or the server can't respond
  const sh = (args: string[], input = "") =>
    new Promise<void>((ok, fail) => {
      const p = execFile(script, args, (e) => (e ? fail(e) : ok()));
      p.stdin!.end(input);
    });
  const run = (input: string) => sh(["claude-code"], input);
  try {
    await run(JSON.stringify(cc("UserPromptSubmit", { prompt: "a\nb" })));
    await run(JSON.stringify(cc("PostToolUse"))); // tool calls aren't recorded when sending fails
    const pending = readFileSync(join(dir, "spool", "pending.jsonl"), "utf8").trim().split("\n");
    assert.equal(pending.length, 1);
    assert.equal(JSON.parse(pending[0]).event.prompt, "a\nb");
    up = true;
    await run(JSON.stringify(cc("Stop")));
    // There's an unsent one: this one is appended and both are flushed in order
    assert.equal(got.length, 1);
    assert.equal(got[0].url, "/api/coders/batch");
    const lines = got[0].body.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.event.hook_event_name), ["UserPromptSubmit", "Stop"]);
    assert.ok(!existsSync(join(dir, "spool", "pending.jsonl")) || !readFileSync(join(dir, "spool", "pending.jsonl"), "utf8").trim());
    // After the flush, the status in Kiki is done, not overwritten by the stale "start working"
    const c = make();
    await c.ingestLines(got[0].body);
    assert.equal(c.list()[0].status, "idle");
    await run(JSON.stringify(cc("Stop")));
    assert.match(got[1].url, /^\/api\/coders\/event\?tool=claude-code&host=/);
    // Codex: the JSON is in the second argument
    await sh(["codex", JSON.stringify({ type: "agent-turn-complete" })]);
    assert.match(got[2].url, /tool=codex/);
  } finally {
    srv.close();
  }
});

test("Old data folders get the Butler added, only once", () => {
  const data = tmp();
  const tpl = join(process.cwd(), "data-template");
  assert.equal(addSetupBao(data, tpl).length, 1);
  assert.ok(existsSync(join(data, "agents", SETUP_BAO, "AGENTS.md")));
  assert.equal(addSetupBao(data, tpl).length, 0);
});
