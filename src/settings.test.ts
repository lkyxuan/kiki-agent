import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { setEnvLine, sourceOf, validName } from "./settings.js";

test("setEnvLine only changes the matching line and keeps comments", () => {
  const src = "# Model\nDEEPSEEK_API_KEY=\nMODEL=deepseek/deepseek-flash\n\n# Port\nPORT=4567\n";
  const out = setEnvLine(src, "DEEPSEEK_API_KEY", "sk-abc");
  assert.equal(out, "# Model\nDEEPSEEK_API_KEY=sk-abc\nMODEL=deepseek/deepseek-flash\n\n# Port\nPORT=4567\n");
});

test("setEnvLine appends when missing and removes the line on delete", () => {
  assert.equal(setEnvLine("PORT=1\n", "MODEL", "x/y"), "PORT=1\nMODEL=x/y\n");
  assert.equal(setEnvLine("", "MODEL", "x/y"), "MODEL=x/y\n");
  assert.equal(setEnvLine("A=1\nKIKI_AUTO_UPDATE=0\nB=2\n", "KIKI_AUTO_UPDATE", undefined), "A=1\nB=2\n");
});

test("setEnvLine quotes values with spaces so parseEnv reads them back", () => {
  const out = setEnvLine("", "MODEL", 'a b#c"d');
  assert.equal(parseEnv(out).MODEL, 'a b#c"d');
});

test("sourceOf distinguishes .env, op references, and external injection", () => {
  assert.equal(sourceOf("sk-1", "sk-1"), "file");
  assert.equal(sourceOf("op://v/i/f", "sk-resolved"), "ref");
  assert.equal(sourceOf("keychain:kiki-deepseek", "sk-resolved"), "ref");
  assert.equal(sourceOf("keychain:kiki-deepseek", ""), "ref");
  assert.equal(sourceOf(undefined, "sk-from-shell"), "external");
  assert.equal(sourceOf("sk-1", "sk-2"), "external");
  assert.equal(sourceOf(undefined, undefined), "unset");
  assert.equal(sourceOf("", ""), "unset");
});

test("validName blocks path traversal", () => {
  assert.ok(validName("dev"));
  assert.ok(validName("Life bot"));
  assert.ok(!validName("../x"));
  assert.ok(!validName("a/b"));
  assert.ok(!validName(""));
});

test("setEnvLine reads back single-quoted values too", () => {
  assert.equal(parseEnv(setEnvLine("", "MODEL", "it's x")).MODEL, "it's x");
});

test("sourceOf does not treat a changed-but-not-restarted value as external injection", () => {
  // At startup .env was sk-old and the process also had sk-old; after changing it to sk-new in settings it is still file
  assert.equal(sourceOf("sk-new", "sk-old", "sk-old"), "file");
  // At startup .env had nothing but the process had a value: external injection
  assert.equal(sourceOf("sk-new", "sk-shell", undefined), "external");
  // At startup it was an op reference (op run resolves it to plaintext); after changing to plaintext it counts as file
  assert.equal(sourceOf("sk-new", "sk-resolved", "op://v/i/f"), "file");
});
