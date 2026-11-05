import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { Agents } from "./agents.js";
import { Worker, type WorkerHooks } from "./workerhost.js";

// Fake child process: real serve() protocol, fake Agents (no model calls)
const dir = mkdtempSync(join(tmpdir(), "kiki-worker-"));
const script = join(dir, "fake.ts");
writeFileSync(
  script,
  `
import { EventEmitter } from "node:events";
import { serve } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "workerchild.ts")).href)};
class Fake extends EventEmitter {
  extensions = [];
  toolsFor;
  async create(agent, name) { return "/x/" + agent + "/" + name + ".jsonl"; }
  async fork(agent, from, name) { return from + "." + name; }
  async send(agent, path, text) {
    this.emit("busy", { path, busy: true });
    try {
      if (text === "hang") return await new Promise(() => {});
      if (text === "slow") await new Promise((r) => setTimeout(r, 100));
      if (text === "crash") process.exit(3);
      if (text === "tool") {
        const t = this.toolsFor(agent)[0];
        const r = await t.execute("call1", { q: 1 }, undefined, undefined, { cwd: "/cwd" });
        return t.name + ":" + r.content[0].text;
      }
      if (text === "approve") {
        let hook;
        for (const f of this.extensions) f({ on: (_n, fn) => (hook = fn) });
        const r = await hook({ toolName: "bash", input: { command: "rm -rf /" } }, { cwd: "/cwd" });
        return r ? "blocked: " + r.reason : "allowed";
      }
      return "reply: " + text + "@" + path;
    } finally {
      this.emit("busy", { path, busy: false });
    }
  }
  async steer(agent, path, text) {}
  async note(agent, path, text) { this.emit("message", { path, role: "assistant", text }); }
}
serve(process, () => new Fake());
`,
);

function hooks(over: Partial<WorkerHooks> = {}): WorkerHooks {
  return {
    tools: () => [{ name: "kiki_ask_user", label: "Ask", description: "d", parameters: { type: "object" } }],
    runTool: async (_a, name, params, path) => ({ content: [{ type: "text", text: `${name}(${JSON.stringify(params)}) in ${path}` }] }),
    approve: async () => undefined,
    ...over,
  };
}

const init = (open: any) => ({ dataDir: dir, model: "m/x", agent: "dev", open });

test("child process: opens a conversation, sends a message, forwards busy/idle events, exits on its own when done", async () => {
  const w = new Worker(script, init({ create: "bg-task" }), hooks());
  const events: string[] = [];
  w.on("event", (name, data) => events.push(`${name}:${data.busy ?? data.text ?? ""}`));
  assert.equal(await w.ready, "/x/dev/bg-task.jsonl");
  assert.equal(await w.send("hello"), "reply: hello@/x/dev/bg-task.jsonl");
  await w.note("report");
  assert.deepEqual(events, ["busy:true", "busy:false", "message:report"]);
  await w.close();
  assert.equal(w.alive, false);
});

test("child process: Kiki's tools run in the main process, carrying this conversation's path", async () => {
  const w = new Worker(script, init({ path: "/s/a.jsonl" }), hooks());
  await w.ready;
  assert.equal(await w.send("tool"), 'kiki_ask_user:kiki_ask_user({"q":1}) in /s/a.jsonl');
  await w.close();
});

test("child process: approvals are decided in the main process, and the block reason is passed back", async () => {
  const seen: any[] = [];
  const w = new Worker(
    script,
    init({ path: "/s/b.jsonl" }),
    hooks({
      approve: async (req) => {
        seen.push(req);
        return { block: true, reason: "user did not approve" };
      },
    }),
  );
  await w.ready;
  assert.equal(await w.send("approve"), "blocked: user did not approve");
  assert.equal(seen[0].path, "/s/b.jsonl");
  assert.equal(seen[0].input.command, "rm -rf /");
  await w.close();
});

test("child process: stopping a task just shuts it down; the in-flight message fails with \"stopped\", and busy state is cleared", async () => {
  const w = new Worker(script, init({ fork: { from: "/s/main.jsonl", name: "bg" } }), hooks());
  assert.equal(await w.ready, "/s/main.jsonl.bg");
  const busy: boolean[] = [];
  w.on("event", (name, data) => name === "busy" && busy.push(data.busy));
  const p = w.send("hang");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(w.busy, true);
  await w.kill();
  await assert.rejects(p, /Stopped/);
  assert.equal(w.busy, false);
  assert.deepEqual(busy, [true, false]);
});

test("child process: on an unexpected crash the in-flight message fails, stating the exit code", async () => {
  const w = new Worker(script, init({ path: "/s/c.jsonl" }), hooks());
  await w.ready;
  await assert.rejects(w.send("crash"), /exited unexpectedly \(exit code 3\)/);
  assert.equal(w.alive, false);
  await assert.rejects(w.send("again"), /already closed/);
});

test("Agents: a report arriving while the child process is still starting is forwarded to the child too, not opened separately in the main process; the child exits once everything is done", async () => {
  const agents = new Agents(mkdtempSync(join(tmpdir(), "kiki-agents-")), "deepseek/deepseek-flash");
  agents.isolation = { script, approve: async () => undefined };
  const seen: string[] = [];
  agents.on("message", (m: any) => seen.push(m.text));
  const reply = agents.sendTask("dev", "/s/q.jsonl", "slow");
  const noted = agents.note("dev", "/s/q.jsonl", "a quick report"); // the child may not be up yet at this point
  assert.equal(await reply, "reply: slow@/s/q.jsonl");
  await noted;
  assert.deepEqual(seen, ["a quick report"], "the report was recorded by the child process");
  assert.equal((agents as any).live.size, 0, "the main process did not open this conversation");
  assert.equal(agents.isRemote("/s/q.jsonl"), false, "the child exits when done");
});
