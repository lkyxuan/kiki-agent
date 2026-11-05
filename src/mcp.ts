// MCP server management: config lives in <data folder>/engine/mcp.json, same format as Claude and Cursor (mcpServers).
// The pi engine reads this file and connects to the servers; tools are called mcp__<server name>__<tool name> in conversations (see createMcpExtension in agents.ts).
// Servers added from the settings page all use "exposure": "direct": tools are shown to the model directly, bypassing pi's codemode scripts, which is the simplest for the model to use.
// Changes take effect in new conversations; conversations already open need Kiki restarted.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

type Cfg = Record<string, unknown>;

export const validServerName = (n: unknown): n is string => typeof n === "string" && /^[\w-]{1,40}$/.test(n);

/** Split a command line into arguments like a shell: supports quotes (also mid-argument, e.g. --dir="a b") and backslash escapes. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (q) throw new Error("Unmatched quote");
  if (has) out.push(cur);
  return out;
}

/** Check field types before saving, so one bad config doesn't break the whole list. */
function checkConfig(c: Cfg) {
  const strs = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const strMap = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
  if (typeof c.url === "string") {
    if (!/^https?:\/\//.test(c.url)) throw new Error("url must start with http:// or https://");
    if (c.headers !== undefined && !strMap(c.headers)) throw new Error("headers must be a string key-value map");
  } else if (typeof c.command === "string" && c.command) {
    if (c.args !== undefined && !strs(c.args)) throw new Error("args must be an array of strings");
    if (c.env !== undefined && !strMap(c.env)) throw new Error("env must be a string key-value map");
  } else throw new Error("JSON must contain command or url");
}

/**
 * Turn the single line entered on the settings page into a config:
 *   https://…           → remote (HTTP) server
 *   cua-driver mcp      → local command
 *   {"command": …}      → use the JSON as-is (also accepts a full {"mcpServers": {"name": {…}}}, in which case the name can be left blank)
 */
export function parseSpec(name: string, spec: string): { name: string; config: Cfg } {
  const s = spec.trim();
  if (!s) throw new Error("Enter a command, URL, or JSON");
  let config: Cfg;
  if (s.startsWith("{")) {
    let j: Cfg;
    try {
      j = JSON.parse(s);
    } catch {
      throw new Error("Invalid JSON");
    }
    if (j.mcpServers && typeof j.mcpServers === "object") {
      const entries = Object.entries(j.mcpServers as Record<string, Cfg>);
      if (entries.length !== 1) throw new Error("Add one server at a time");
      [name, config] = [name || entries[0][0], entries[0][1]];
    } else config = j;
    if (!config || typeof config !== "object") throw new Error("Invalid JSON");
  } else if (/^https?:\/\//.test(s)) {
    if (/\s/.test(s)) throw new Error("URL cannot contain spaces");
    config = { url: s };
  } else {
    const [command, ...args] = splitCommand(s);
    config = args.length ? { command, args } : { command };
  }
  checkConfig(config);
  if (!validServerName(name)) throw new Error("Name can only use letters, numbers, - and _, up to 40 characters");
  return { name, config: { ...config, exposure: config.exposure ?? "direct" } };
}

/** The line shown in the list: command and args, or the URL. */
export function summary(c: Cfg): string {
  if (typeof c?.url === "string") return c.url;
  const args = Array.isArray(c?.args) ? c.args : [];
  return [c?.command, ...args].map(String).join(" ");
}

/**
 * Preset servers: the settings page has a toggle for these, no manual entry needed. When turned on, the full path to the program is found and written into mcp.json
 * (Kiki runs in the background with a short PATH, so a bare command name often isn't found).
 */
export const PRESETS: Record<string, { desc: string; bin: string; dirs: string[]; args: string[]; install: string }> = {
  "cua-driver": {
    desc: "Control apps on your Mac: see the screen, click, type",
    bin: "cua-driver",
    dirs: ["/Applications/CuaDriver.app/Contents/MacOS", join(homedir(), "Applications", "CuaDriver.app", "Contents", "MacOS")],
    args: ["mcp"],
    install: '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"',
  },
};

/** Look for the program in common locations and on PATH; returns undefined if not found. */
export function findBin(bin: string, extraDirs: string[] = []): string | undefined {
  const dirs = [
    join(homedir(), ".local", "bin"),
    ...extraDirs,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.env.PATH ?? "").split(delimiter),
  ].filter(Boolean);
  for (const d of dirs) if (existsSync(join(d, bin))) return join(d, bin);
}

export interface ServerRow {
  name: string;
  preset: boolean;
  summary: string;
  on: boolean;
  desc?: string;
  installed?: boolean;
  install?: string;
}

export class Mcp {
  readonly file: string;
  constructor(engineDir: string) {
    this.file = join(engineDir, "mcp.json");
  }

  private read(): { mcpServers: Record<string, Cfg>; [k: string]: unknown } {
    const j = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    j.mcpServers ??= {};
    return j;
  }

  private write(j: object) {
    writeFileSync(this.file, JSON.stringify(j, null, 2) + "\n");
  }

  /** Presets come first (listed even if not configured, with the toggle off), then your own. */
  list(find = findBin): ServerRow[] {
    const servers = this.read().mcpServers;
    const presets = Object.entries(PRESETS).map(([name, p]) => {
      const c = servers[name];
      const saved = typeof c?.command === "string" && c.command.includes("/") && existsSync(c.command) ? c.command : undefined;
      const path = saved ?? find(p.bin, p.dirs);
      const installed = !!path;
      return {
        name,
        preset: true,
        desc: p.desc,
        summary: c ? summary(c) : installed ? `${path} ${p.args.join(" ")}` : "Not installed",
        installed,
        install: p.install,
        on: !!c && c.enabled !== false,
      };
    });
    const own = Object.entries(servers)
      .filter(([name]) => !PRESETS[name])
      .map(([name, c]) => ({ name, preset: false, summary: summary(c), on: c.enabled !== false }));
    return [...presets, ...own];
  }

  add(name: string, spec: string) {
    const r = parseSpec(name, spec);
    const j = this.read();
    if (j.mcpServers[r.name]) throw new Error(`A server named ${r.name} already exists; remove it before adding`);
    j.mcpServers[r.name] = r.config;
    this.write(j);
    return r.name;
  }

  setOn(name: string, on: boolean, find = findBin) {
    const j = this.read();
    const p = PRESETS[name];
    if (p && on) {
      const cur = j.mcpServers[name];
      const cmd = typeof cur?.command === "string" ? cur.command : "";
      // Not configured yet, or configured with a bare command name (not found on the background PATH), or the path is stale: find the full path
      if (!cur || !cmd.includes("/") || !existsSync(cmd)) {
        const path = find(p.bin, p.dirs);
        if (!path) throw new Error(`${name} is not installed yet. Run this in Terminal: ${p.install}`);
        // For existing configs only replace command; keep everything else (args, env, etc.) as-is
        j.mcpServers[name] = cur ? { ...cur, command: path } : { command: path, args: p.args, exposure: "direct", description: p.desc };
      }
    }
    const c = j.mcpServers[name];
    if (!c) {
      if (p) return; // preset not configured yet; off is off
      throw new Error(`No ${name}`);
    }
    if (on) delete c.enabled;
    else c.enabled = false;
    this.write(j);
  }

  remove(name: string) {
    const j = this.read();
    if (!j.mcpServers[name]) throw new Error(`No ${name}`);
    delete j.mcpServers[name];
    this.write(j);
  }
}
