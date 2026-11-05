import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_BAO, dropConfirmLine, migrateToQiqi, NEW_CONFIRM_LINE, OLD_CONFIRM_LINE } from "./migrate.js";

const tpl = join(import.meta.dirname, "..", "data-template");

test("old data folder: create Kiki, move dev/life into archive, conversation files still there", () => {
  const d = mkdtempSync(join(tmpdir(), "kiki-"));
  mkdirSync(join(d, "agents", "dev", "sessions"), { recursive: true });
  writeFileSync(join(d, "agents", "dev", "sessions", "a.jsonl"), "{}\n");
  mkdirSync(join(d, "agents", "life"), { recursive: true });
  mkdirSync(join(d, "agents", "work"), { recursive: true });
  writeFileSync(join(d, "routing-rules.md"), "- When nothing fits well, hand it to the Life bot (life).\n");
  writeFileSync(join(d, "registry.json"), JSON.stringify({
    sessions: [{ agent: "dev", name: "a", path: "/x/a.jsonl" }, { agent: "work", name: "b", path: "/x/b.jsonl" }],
    chats: { app: "/x/a.jsonl", other: "/x/b.jsonl" },
  }));
  const log = migrateToQiqi(d, tpl, new Date("2026-11-01T00:00:00Z"));
  assert.ok(existsSync(join(d, "agents", DEFAULT_BAO, "AGENTS.md")));
  assert.ok(!existsSync(join(d, "agents", "dev")));
  assert.ok(!existsSync(join(d, "agents", "life")));
  assert.ok(existsSync(join(d, "agents", "work")), "the user's own bots are left alone");
  assert.ok(existsSync(join(d, "archive", "agents-2026-11-01", "dev", "sessions", "a.jsonl")));
  assert.match(readFileSync(join(d, "routing-rules.md"), "utf8"), /hand it to Kiki\./);
  const reg = JSON.parse(readFileSync(join(d, "registry.json"), "utf8"));
  assert.deepEqual(reg.sessions.map((x: any) => x.agent), ["work"], "drop archived conversations from the registry");
  assert.deepEqual(reg.chats, { other: "/x/b.jsonl" }, "clear current selections that point at archived conversations");
  assert.ok(log.length >= 4);
  assert.deepEqual(migrateToQiqi(d, tpl), [], "only runs once");
});

test("new data folder (template already has Kiki): nothing to move", () => {
  const d = mkdtempSync(join(tmpdir(), "kiki-"));
  mkdirSync(join(d, "agents", DEFAULT_BAO), { recursive: true });
  assert.deepEqual(migrateToQiqi(d, tpl), []);
});

test("Kiki's note: replace the unmodified old version with the new one, leave modified ones alone", async () => {
  const { upgradeQiqiNote, OLD_QIQI: old } = await import("./migrate.js");
  const d = mkdtempSync(join(tmpdir(), "kiki-"));
  mkdirSync(join(d, "agents", "Kiki"), { recursive: true });
  const f = join(d, "agents", "Kiki", "AGENTS.md");
  writeFileSync(f, old);
  assert.equal(upgradeQiqiNote(d, tpl).length, 1);
  assert.match(readFileSync(f, "utf8"), /I don't take on concrete work myself/);
  writeFileSync(f, old + "\nA line I added myself\n");
  assert.deepEqual(upgradeQiqiNote(d, tpl), []);
});

test("add new sections to routing rules, placed before \"chat or background\"; don't add ones that already exist", async () => {
  const { addRuleSections } = await import("./migrate.js");
  const d = mkdtempSync(join(tmpdir(), "kiki-"));
  writeFileSync(join(d, "routing-rules.md"), "# Rules\n\n## Something I changed\n- my own\n\n## Chat or background\n- old\n");
  const tpl = join(process.cwd(), "data-template");
  assert.deepEqual(addRuleSections(d, tpl), ["added \"when another bot's business comes up in a conversation\" to the routing rules"]);
  const s = readFileSync(join(d, "routing-rules.md"), "utf8");
  assert.ok(s.indexOf("## When another bot's business comes up in a conversation") < s.indexOf("## Chat or background"));
  assert.match(s, /## Something I changed\n- my own/);
  assert.deepEqual(addRuleSections(d, tpl), []);
});

test("replace \"confirm before anything irreversible\" in routing rules with the full-auto wording, only once", () => {
  const d = mkdtempSync(join(tmpdir(), "kiki-"));
  writeFileSync(join(d, "routing-rules.md"), `## Don't ask, just do it\n\n${OLD_CONFIRM_LINE}\n`);
  assert.equal(dropConfirmLine(d).length, 1);
  assert.match(readFileSync(join(d, "routing-rules.md"), "utf8"), new RegExp(NEW_CONFIRM_LINE.slice(2, 12)));
  assert.equal(dropConfirmLine(d).length, 0);
  assert.equal(readFileSync(join(tpl, "routing-rules.md"), "utf8").includes(OLD_CONFIRM_LINE), false);
});
