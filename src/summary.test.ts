import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Registry } from "./registry.js";
import { cleanSummary, SUMMARY_MAX, Summaries } from "./summary.js";

const reg = () => new Registry(join(mkdtempSync(join(tmpdir(), "kiki-")), "registry.json"));

test("summary is cleaned into one line, quotes removed, truncated to the limit", () => {
  assert.equal(cleanSummary("Summary: \"Picking an iPad for mom, leaning toward the Air\"\nextra line"), "Picking an iPad for mom, leaning toward ");
  assert.equal([...cleanSummary("x".repeat(80))].length, SUMMARY_MAX);
});

test("writes a summary after replying; only writes once across several calls in a row; records activity time even if the model errors", async () => {
  const r = reg();
  r.add({ agent: "life", name: "iPad", path: "/p1", created: "2026-01-01T00:00:00.000Z" });
  const prompts: string[] = [];
  let fail = false;
  const s = new Summaries({
    registry: r,
    history: () => [{ role: "user", text: "Buy mom an iPad" }, { role: "assistant", text: "Recommend the Air" }],
    complete: async (_sys, user) => {
      prompts.push(user);
      if (fail) throw new Error("no key");
      return "Picking an iPad for mom, recommend the Air";
    },
    delayMs: 5,
  });
  s.schedule("/p1");
  s.schedule("/p1");
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(prompts.length, 1);
  assert.equal(r.byPath("/p1")?.summary, "Picking an iPad for mom, recommend the A");
  fail = true;
  await s.run("/p1");
  assert.match(prompts[1], /Old summary: Picking an iPad for mom, recommend the A/);
  assert.equal(r.byPath("/p1")?.summary, "Picking an iPad for mom, recommend the A"); // keep the old one if it can't be written
  assert.ok(r.byPath("/p1")?.active);
  s.schedule("/nope"); // ignore anything not in the registry
});
