import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTool, stepsFromMessages, summarize } from "./activity.js";

test("tool calls rendered in plain language", () => {
  assert.deepEqual(describeTool("bash", { command: "ls -la\n  /tmp" }), { title: "Run command", detail: "ls -la /tmp" });
  assert.deepEqual(describeTool("read", { path: "/Users/x/Kiki/agents/Kiki/AGENTS.md" }), { title: "Read file", detail: "AGENTS.md" });
  assert.equal(describeTool("mcp__notion__search", { query: "weekly report" }).title, "Use search from notion");
  assert.equal(describeTool("mcp__notion__search", { query: "weekly report" }).detail, "weekly report");
  assert.deepEqual(describeTool("kiki_peek", { target: "Kiki/weekly report" }, { kiki_peek: "Peek at another conversation" }), { title: "Peek at another conversation", detail: "Kiki/weekly report" });
  assert.equal(describeTool("whatever", {}).title, "Use tool whatever");
  assert.ok(describeTool("bash", { command: "x".repeat(200) }).detail.length <= 80);
});

test("summary of a completed turn", () => {
  assert.equal(summarize([{ id: "1", title: "", detail: "", status: "done" }, { id: "2", title: "", detail: "", status: "error" }]), "Used 2 tools, 1 failed");
});

test("tools used before each reply in an old conversation", () => {
  const final = { role: "assistant", content: [{ type: "text", text: "Done" }] };
  const msgs = [
    { role: "user", content: "Take a look" },
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "ls", arguments: {} }] },
    { role: "toolResult", toolCallId: "a", isError: false },
    { role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "false" } }] },
    { role: "toolResult", toolCallId: "b", isError: true },
    final,
  ];
  const steps = stepsFromMessages(msgs).get(final)!;
  assert.deepEqual(steps.map((s) => [s.title, s.status]), [["List folder", "done"], ["Run command", "error"]]);
});
