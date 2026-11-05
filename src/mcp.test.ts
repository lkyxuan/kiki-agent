import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Mcp, parseSpec, PRESETS, splitCommand } from "./mcp.js";

test("splits command-line arguments, supports quotes", () => {
  assert.deepEqual(splitCommand(`npx -y "@scope/pkg" --dir 'a b'`), ["npx", "-y", "@scope/pkg", "--dir", "a b"]);
  assert.deepEqual(splitCommand(`srv --directory="/Users/me/My Files" ''`), ["srv", "--directory=/Users/me/My Files", ""]);
  assert.deepEqual(splitCommand(`/Applications/My\\ App/bin/srv mcp`), ["/Applications/My App/bin/srv", "mcp"]);
  assert.throws(() => splitCommand(`a "b`));
});

test("a line entered on the settings page becomes config", () => {
  assert.deepEqual(parseSpec("cua-driver", "cua-driver mcp"), {
    name: "cua-driver",
    config: { command: "cua-driver", args: ["mcp"], exposure: "direct" },
  });
  assert.deepEqual(parseSpec("docs", "https://example.com/mcp").config, { url: "https://example.com/mcp", exposure: "direct" });
  const pasted = parseSpec("", `{"mcpServers":{"cua":{"command":"/usr/local/bin/cua-driver","args":["mcp"]}}}`);
  assert.equal(pasted.name, "cua");
  assert.equal(pasted.config.command, "/usr/local/bin/cua-driver");
  assert.equal(parseSpec("x", `{"command":"a","exposure":"codemode"}`).config.exposure, "codemode");
  assert.throws(() => parseSpec("bad name", "a"));
  assert.throws(() => parseSpec("x", ""));
  assert.throws(() => parseSpec("x", `{"args":[]}`));
  assert.throws(() => parseSpec("x", `{"command":"server","args":123}`));
  assert.throws(() => parseSpec("x", `{"url":"ftp://x"}`));
});

test("add, disable, remove only touch the corresponding entry in mcp.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-mcp-"));
  const m = new Mcp(dir);
  const own = () => m.list().filter((s) => !s.preset);
  assert.deepEqual(own(), []);
  m.add("fs", "npx fs-server");
  m.add("docs", "https://example.com/mcp");
  assert.throws(() => m.add("docs", "https://x"));
  m.setOn("docs", false);
  assert.deepEqual(own(), [
    { name: "fs", preset: false, summary: "npx fs-server", on: true },
    { name: "docs", preset: false, summary: "https://example.com/mcp", on: false },
  ]);
  m.setOn("docs", true);
  assert.equal(JSON.parse(readFileSync(m.file, "utf8")).mcpServers.docs.enabled, undefined);
  m.remove("fs");
  assert.deepEqual(own().map((s) => s.name), ["docs"]);
});

test("preset cua-driver: listed even when never configured, writes the full path when enabled", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-mcp-"));
  const m = new Mcp(dir);
  const none = () => undefined;
  const cua = m.list(none).find((s) => s.name === "cua-driver")!;
  assert.equal(cua.preset, true);
  assert.equal(cua.on, false);
  assert.equal(cua.installed, false);
  assert.throws(() => m.setOn("cua-driver", true, none), /is not installed/);
  m.setOn("cua-driver", false, none); // never configured, disabling doesn't error

  const bin = join(dir, "cua-driver");
  writeFileSync(bin, "");
  const found = () => bin;
  assert.equal(m.list(found)[0].installed, true);
  m.setOn("cua-driver", true, found);
  const cfg = JSON.parse(readFileSync(m.file, "utf8")).mcpServers["cua-driver"];
  assert.deepEqual([cfg.command, cfg.args, cfg.exposure], [bin, PRESETS["cua-driver"].args, "direct"]);
  assert.equal(m.list(found)[0].on, true);
  m.setOn("cua-driver", false, found);
  assert.equal(m.list(found)[0].on, false);
  assert.equal(JSON.parse(readFileSync(m.file, "utf8")).mcpServers["cua-driver"].command, bin);
});

test("previously hand-entered cua-driver mcp: swapped to the full path when enabled, other settings preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-mcp-"));
  const m = new Mcp(dir);
  m.add("cua-driver", `{"command":"cua-driver","args":["mcp","--x"],"env":{"A":"1"}}`);
  m.setOn("cua-driver", false);
  const bin = join(dir, "cua-driver");
  writeFileSync(bin, "");
  m.setOn("cua-driver", true, () => bin);
  const cfg = JSON.parse(readFileSync(m.file, "utf8")).mcpServers["cua-driver"];
  assert.deepEqual(cfg, { command: bin, args: ["mcp", "--x"], env: { A: "1" }, exposure: "direct" });
});
