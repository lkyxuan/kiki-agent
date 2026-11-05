import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Agents } from "./agents.js";

/** Fake pi session: prompt only resolves on release; counts calls and disposals. */
function stub() {
  let release = () => {};
  const st = { prompts: 0, disposed: 0, aborted: 0 };
  const s: any = {
    messages: [],
    isStreaming: false,
    prompt: () => {
      st.prompts++;
      return new Promise<void>((r) => (release = r));
    },
    abort: async () => {
      st.aborted++;
      release();
    },
    dispose: () => void st.disposed++,
  };
  return { s, st };
}

test("discard conversation: the running one stops, queued messages no longer run; records move to Trash, same name and same second don't overwrite each other", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-agents-"));
  const agents = new Agents(dir, "deepseek/deepseek-flash");
  const p1 = join(dir, "a-1.jsonl"), p2 = join(dir, "a-2.jsonl");
  writeFileSync(p1, "{}\n");
  writeFileSync(p2, "{}\n");
  const { s, st } = stub();
  (agents as any).live.set(p1, s);
  const first = agents.send("Kiki", p1, "one").catch(() => "");
  const second = agents.send("Kiki", p1, "two"); // queued behind
  await new Promise((r) => setImmediate(r));
  await agents.discard("Kiki", p1, "a:b");
  await first;
  await assert.rejects(second, /deleted/);
  assert.equal(st.prompts, 1);
  assert.equal(st.aborted, 1);
  assert.equal(st.disposed, 1);
  await agents.discard("Kiki", p2, "a?b"); // names both sanitize to a_b
  assert.ok(!existsSync(p1) && !existsSync(p2));
  assert.equal(readdirSync(join(dir, "trash", "Kiki")).length, 2);
});
