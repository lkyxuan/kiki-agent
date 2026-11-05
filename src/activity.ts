// Progress shown to the user while a conversation is working: thinking, which tool is being called, how many steps have run.
// All data comes from pi events (see watch in agents.ts); this file only turns tool calls into plain language.
import { basename } from "node:path";

export interface Step {
  id: string;
  title: string; // Plain-language action, e.g. "Run command"
  detail: string; // A bit more context, e.g. the command itself or a file name; may be empty
  status: "running" | "done" | "error";
  ms?: number; // How long it took to finish
}

/** The progress of one turn in a conversation. */
export interface Live {
  since: number; // When work started (ms)
  status: string; // What's happening now, e.g. "Thinking…"
  steps: Step[];
}

const BUILTIN: Record<string, string> = {
  read: "Read file",
  write: "Write file",
  edit: "Edit file",
  bash: "Run command",
  powershell: "Run command",
  grep: "Search content",
  find: "Find files",
  ls: "List folder",
  tool_search: "Find available tools",
  code: "Run some code",
};

const clip = (s: string, n = 80) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/** Turn a tool call into plain language. labels are the English names of Kiki's own tools (ToolDefinition.label). */
export function describeTool(name: string, args: any, labels: Record<string, string> = {}): { title: string; detail: string } {
  const a = args && typeof args === "object" ? args : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let title = labels[name] ?? BUILTIN[name];
  if (!title) {
    const mcp = name.match(/^mcp__(.+?)__(.+)$/);
    title = mcp ? `Use ${mcp[2]} from ${mcp[1]}` : `Use tool ${name}`;
  }
  let detail = "";
  switch (name) {
    case "read":
    case "write":
    case "edit":
      detail = str(a.path) ? basename(str(a.path)) : "";
      break;
    case "ls":
      detail = str(a.path) ? basename(str(a.path)) : "current folder";
      break;
    case "bash":
    case "powershell":
      detail = str(a.command);
      break;
    case "grep":
    case "find":
      detail = str(a.pattern);
      break;
    default: {
      // Other tools: pick the first string argument that looks like a "target"
      const key = ["target", "name", "query", "url", "path", "text", "title"].find((k) => str(a[k]));
      detail = key ? str(a[key]) : (Object.values(a).find((v) => typeof v === "string") as string) ?? "";
    }
  }
  return { title, detail: clip(detail) };
}

/** A one-line summary after a turn finishes: "Used 3 tools" / "Used 3 tools, 1 failed". */
export function summarize(steps: Step[]): string {
  const bad = steps.filter((s) => s.status === "error").length;
  return `Used ${steps.length} tool${steps.length === 1 ? "" : "s"}${bad ? `, ${bad} failed` : ""}`;
}

/** Pull the tools used before each reply out of a conversation's messages (shows collapsed steps when opening an old conversation). */
export function stepsFromMessages(msgs: any[], labels: Record<string, string> = {}): Map<any, Step[]> {
  const out = new Map<any, Step[]>(); // assistant message -> tools used before it (in the same turn)
  const errors = new Set<string>();
  for (const m of msgs) if (m.role === "toolResult" && m.isError) errors.add(m.toolCallId);
  let pending: Step[] = [];
  for (const m of msgs) {
    if (m.role === "user") pending = [];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const hasText = m.content.some((c: any) => c.type === "text" && c.text?.trim());
    if (hasText && pending.length) {
      out.set(m, pending);
      pending = [];
    }
    for (const c of m.content)
      if (c.type === "toolCall")
        pending.push({ id: c.id, ...describeTool(c.name, c.arguments, labels), status: errors.has(c.id) ? "error" : "done" });
  }
  return out;
}
