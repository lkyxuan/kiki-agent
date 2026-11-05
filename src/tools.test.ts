import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { remember } from "./tools.js";

test("kiki_remember: writes into About me / the bot's notes, adds the heading the first time, only appends afterwards", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-"));
  writeFileSync(join(dir, "AGENTS.md"), "# About me\n\n- Language: English");
  mkdirSync(join(dir, "agents", "dev"), { recursive: true });
  assert.match(remember(dir, ["dev"], "me", "likes the conclusion first\nthen the explanation"), /Saved to "About me": likes the conclusion first then the explanation/);
  remember(dir, ["dev"], "me", "timezone Beijing");
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "# About me\n\n- Language: English\n\n## Notes\n\n- likes the conclusion first then the explanation\n- timezone Beijing\n");
  remember(dir, ["dev"], "dev", "code in TypeScript");
  assert.match(readFileSync(join(dir, "agents", "dev", "AGENTS.md"), "utf8"), /## Notes\n\n- code in TypeScript\n$/);
  assert.throws(() => remember(dir, ["dev"], "work", "x"), /No bot "work"/);
  assert.throws(() => remember(dir, ["dev"], "me", "  "), /empty/);
});

test("createBao: writes the notes file, errors on duplicate and bad names", async () => {
  const { createBao, baoFile } = await import("./bao.js");
  const dir = mkdtempSync(join(tmpdir(), "kiki-"));
  createBao(dir, "Life bot", "Daily life: shopping,\nthings at home");
  assert.match(readFileSync(baoFile(dir, "Life bot"), "utf8"), /^# Life bot\n\n## What I'm responsible for\nDaily life: shopping, things at home\n/);
  assert.throws(() => createBao(dir, "Life bot", "x"), /already exists/);
  assert.throws(() => createBao(dir, "../x", "x"), /not allowed/);
});

test("bot settings: only change the \"What I'm responsible for\" section, leave everything else as is", async () => {
  const { baoDoc, readDuty, setDuty } = await import("./bao.js");
  const md = baoDoc("Work", "manage projects") + "\n## Notes\n\n- Monday meeting\n";
  assert.equal(readDuty(md), "manage projects");
  const next = setDuty(md, "Work", "  manage meetings\n\n## and email \n");
  assert.equal(readDuty(next), "manage meetings\nand email");
  assert.equal(next.replace("manage meetings\nand email", "manage projects"), md);
  assert.equal(setDuty("# Work\n\n## How I work\n- x\n", "Work", "a"), "# Work\n\n## What I'm responsible for\na\n\n## How I work\n- x\n");
  assert.equal(readDuty(setDuty("", "Work", "")), "things related to Work");
  // "What I'm responsible for" is empty and the next heading follows immediately: must not swallow the section after it
  const tight = "# Work\n\n## What I'm responsible for\n## How I work\n- keep the rules\n";
  assert.equal(readDuty(tight), "");
  assert.equal(setDuty(tight, "Work", "manage projects"), "# Work\n\n## What I'm responsible for\nmanage projects\n\n## How I work\n- keep the rules\n");
  assert.equal(setDuty("# Work\n\n## What I'm responsible for", "Work", "x"), "# Work\n\n## What I'm responsible for\nx\n");
});
