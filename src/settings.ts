// Settings page API: /api/settings*. The page is public/settings.html.
//
// Config is written back to <data folder>/.env: only the matching line is changed, comments and other lines are left as-is. Changes take effect after restarting Kiki (the exception is a DeepSeek API key entered directly, which takes effect immediately).
// If a value was injected from outside when the process started (e.g. via op run, or exported in the terminal), changing it here has no effect; the UI will flag it.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { baoDoc, readDuty, setDuty } from "./bao.js";
import { Extensions, validSource } from "./extensions.js";
import { listFeatures, setFeature } from "./features.js";
import { listApproval, removeAlways, setAuto, setMode } from "./approval.js";
import { MacPermissions } from "./macperm.js";
import { Mcp } from "./mcp.js";
import { VERSION } from "./update.js";

/** Keys that can be changed from the settings page. Other keys can only be edited in .env by hand. */
export const KEYS = {
  MODEL: { secret: false },
  DEEPSEEK_API_KEY: { secret: true },
  DEFAULT_AGENT: { secret: false },
  KIKI_AUTO_UPDATE: { secret: false },
} as const;
type Key = keyof typeof KEYS;

export type Source = "file" | "ref" | "external" | "unset";

/** API key reference: resolved to the real value by kiki-server when Kiki.app starts (keychain:<name> reads from the keychain, op://… reads from 1Password). */
export const isRef = (v: string | undefined) => !!v && (v.startsWith("op://") || v.startsWith("keychain:"));

/**
 * Where a key's value comes from: the .env file, an API key reference in .env (keychain or 1Password), external injection, or not set.
 * Whether it's externally injected must be compared against the .env as it was "at startup" (startVal), not the current file:
 * otherwise a value changed on the settings page but not yet restarted would be mistaken for external injection.
 */
export function sourceOf(fileVal: string | undefined, envVal: string | undefined, startVal = fileVal): Source {
  const fromStartFile = envVal === startVal || isRef(startVal);
  if (envVal !== undefined && envVal !== "" && !fromStartFile) return "external";
  if (isRef(fileVal)) return "ref";
  if (fileVal !== undefined && fileVal !== "") return "file";
  return "unset";
}

/** Change only the line for key in .env; append it at the end if missing. If value is undefined, delete that line. */
export function setEnvLine(src: string, key: string, value: string | undefined): string {
  const lines = src === "" ? [] : src.split("\n");
  const re = new RegExp(`^\\s*(export\\s+)?${key}\\s*=`);
  // node's parseEnv doesn't understand backslash escapes, so pick a quote character that doesn't appear in the value and wrap it
  const q = value !== undefined && /[\s#"'`\\]/.test(value) ? ["'", '"', "`"].find((c) => !value.includes(c)) : "";
  if (q === undefined) throw new Error("A value cannot contain all three quote characters ' \" `");
  const quoted = value === undefined ? undefined : `${q}${value}${q}`;
  const idx = lines.findIndex((l) => re.test(l));
  if (value === undefined) {
    if (idx >= 0) lines.splice(idx, 1);
  } else if (idx >= 0) lines[idx] = `${key}=${quoted}`;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${quoted}`, "");
  }
  return lines.join("\n");
}

/** A bot's avatar: a single emoji (a few characters at most); discard it if invalid */
export const baoEmoji = (e: unknown) =>
  typeof e === "string" && e.trim() && [...e.trim()].length <= 8 && !/[<>&"'\s]/.test(e.trim()) ? e.trim() : "";

/** Read a bot's appearance settings (agents/<name>/bao.json); empty if missing */
export function baoLook(dataDir: string, name: string): { emoji?: string } {
  try {
    const emoji = baoEmoji(JSON.parse(readFileSync(join(dataDir, "agents", name, "bao.json"), "utf8")).emoji);
    return emoji ? { emoji } : {};
  } catch {
    return {};
  }
}

export const validName = (n: unknown): n is string =>
  typeof n === "string" && /^[\p{L}\p{N}_-]{1,40}$/u.test(n);

const mask = (v: string) => (v.length <= 8 ? "••••" : `${v.slice(0, 3)}••••${v.slice(-4)}`);

function run(cmd: string, args: string[], timeout = 4000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout }, (err, out) => (err ? reject(err) : resolve(String(out)))),
  );
}

async function runFirst(cmds: string[], args: string[]) {
  let last: unknown;
  for (const c of cmds) {
    try {
      return await run(c, args);
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const TAILSCALE = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale"];

/** Tailscale status: installed or not, connected or not, and the address usable from a phone (when tailscale serve is on). */
async function remote(port: number) {
  try {
    const st = JSON.parse(await runFirst(TAILSCALE, ["status", "--json"]));
    const dns = String(st.Self?.DNSName ?? "").replace(/\.$/, "");
    const online = st.BackendState === "Running";
    let serving = false;
    try {
      serving = (await runFirst(TAILSCALE, ["serve", "status"])).includes(String(port));
    } catch {}
    return { installed: true, online, serving, url: dns ? `https://${dns}` : undefined };
  } catch {
    return { installed: false, online: false, serving: false };
  }
}

export function settingsApi(opts: { dataDir: string; port: number }) {
  const macPerms = new MacPermissions(opts.dataDir);
  const envFile = join(opts.dataDir, ".env");
  const aboutFile = join(opts.dataDir, "AGENTS.md");
  const agentsDir = join(opts.dataDir, "agents");
  const readEnvFile = () => (existsSync(envFile) ? readFileSync(envFile, "utf8") : "");
  const fileVals = () => parseEnv(readEnvFile()) as Record<string, string>;
  const startVals = fileVals(); // what .env looked like at startup, used to tell which values were externally injected
  const source = (k: string) => sourceOf(fileVals()[k], process.env[k], startVals[k]);
  const agentFile = (name: string) => join(agentsDir, name, "AGENTS.md");
  // Change a few fields in bao.json, leaving other fields (added later) as-is; if a value is undefined, delete that field
  const writeLook = (name: string, patch: Record<string, unknown>) => {
    const f = join(agentsDir, name, "bao.json");
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(readFileSync(f, "utf8")); } catch {}
    const next = { ...cur, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    writeFileSync(f, JSON.stringify(next) + "\n");
  };
  const listAgents = () =>
    existsSync(agentsDir) ? readdirSync(agentsDir).filter((n) => statSync(join(agentsDir, n)).isDirectory()) : [];
  // Whether this process is running as Kiki.app's launchd service: if so, it can restart itself
  const canRestart = () => !!process.env.KIKI_APP;
  const exts = new Extensions(join(opts.dataDir, "engine"));
  const mcp = new Mcp(join(opts.dataDir, "engine"));
  let changed = false; // settings changed that require a restart

  /** The API key actually to use: if .env holds an op:// reference that the process hasn't resolved, resolve it on the spot with op read. */
  /** The API key for testing: use the process value if externally injected; otherwise use what's currently stored in .env (including changes not yet restarted); resolve API key references on the spot (security for keychain, op read for 1Password). */
  async function resolvedKey(): Promise<string | undefined> {
    const k = "DEEPSEEK_API_KEY";
    const val = source(k) === "external" ? process.env[k] : fileVals()[k];
    if (val?.startsWith("op://")) return (await run("op", ["read", val], 20000)).trim();
    if (val?.startsWith("keychain:"))
      return (await run("security", ["find-generic-password", "-s", val.slice("keychain:".length), "-w"])).trim();
    return val || undefined;
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
    const json = (data: unknown, code = 200) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    };
    const body = async () => {
      let s = "";
      for await (const chunk of req) s += chunk;
      return JSON.parse(s || "{}");
    };
    const p = url.pathname;
    const post = req.method === "POST";

    // Overview: what the page needs as soon as it opens
    if (p === "/api/settings" && !post) {
      const file = fileVals();
      const env: Record<string, unknown> = {};
      for (const k of Object.keys(KEYS) as Key[]) {
        const fv = file[k];
        const ev = process.env[k];
        const src = source(k);
        const shown = src === "external" ? ev : fv;
        env[k] = {
          source: src,
          value: shown === undefined ? "" : KEYS[k].secret && src !== "ref" ? (shown ? mask(shown) : "") : shown,
        };
      }
      return json({
        version: VERSION,
        dataDir: opts.dataDir,
        envFile,
        env,
        agents: listAgents(),
        changed,
        canRestart: canRestart(),
      });
    }

    if (p === "/api/settings/remote") return json(await remote(opts.port));

    // Change one setting: { key, value }; an empty string for value means delete that line
    if (p === "/api/settings/env" && post) {
      const { key, value } = await body();
      if (!(key in KEYS)) return json({ error: `${key} cannot be changed from the settings page` }, 400);
      if (typeof value !== "string" || /[\r\n]/.test(value)) return json({ error: "The value cannot contain line breaks" }, 400);
      if (source(key) === "external")
        return json({ error: "This value was injected externally at startup; changing it here has no effect" }, 409);
      const v = value.trim();
      writeFileSync(envFile, setEnvLine(readEnvFile(), key, v === "" ? undefined : v), { mode: 0o600 }); // contains API keys, so on creation only the owner can read/write
      if (key === "DEEPSEEK_API_KEY" && !isRef(v)) {
        // A directly entered API key takes effect immediately (the engine reads the environment variable each time it calls the model), so new users can chat right after entering it without restarting first.
        // Also update the startup snapshot so sourceOf doesn't treat it as an externally injected value.
        if (v) process.env[key] = v;
        else delete process.env[key];
        if (v) startVals[key] = v;
        else delete startVals[key];
      } else changed = true;
      return json({ ok: true, changed });
    }

    // About me
    if (p === "/api/settings/about") {
      if (!post) return json({ path: aboutFile, text: existsSync(aboutFile) ? readFileSync(aboutFile, "utf8") : "" });
      const { text } = await body();
      if (typeof text !== "string") return json({ error: "Missing text" }, 400);
      writeFileSync(aboutFile, text);
      return json({ ok: true });
    }

    // A bot's description: GET ?name=dev reads it (including "What I'm responsible for" and the avatar), POST {name, text} writes the whole description,
    // POST {name, create:true} creates a new one, POST {name, edit:true, about, emoji} changes responsibilities and avatar from the bot settings dialog
    if (p === "/api/settings/agent") {
      if (!post) {
        const name = url.searchParams.get("name");
        if (!validName(name) || !listAgents().includes(name)) return json({ error: "No such bot" }, 404);
        const f = agentFile(name);
        const text = existsSync(f) ? readFileSync(f, "utf8") : "";
        return json({ name, path: f, text, about: readDuty(text), ...baoLook(opts.dataDir, name) });
      }
      const { name, text, create, edit, about, emoji } = await body();
      if (!validName(name)) return json({ error: "Names may only use letters, numbers, Chinese characters, - and _, up to 40 characters" }, 400);
      const exists = listAgents().includes(name);
      if (create) {
        if (exists) return json({ error: "This bot already exists" }, 400);
        mkdirSync(join(agentsDir, name), { recursive: true });
        // The "What I'm responsible for" entered in the create dialog is written into AGENTS.md; change it later under "Edit description"
        const duty = typeof about === "string" ? about.trim().slice(0, 500) : "";
        writeFileSync(agentFile(name), typeof text === "string" && text ? text : baoDoc(name, duty));
        const face = baoEmoji(emoji);
        if (face) writeFileSync(join(agentsDir, name, "bao.json"), JSON.stringify({ emoji: face }) + "\n");
        return json({ ok: true });
      }
      if (!exists) return json({ error: "No such bot" }, 404);
      if (edit) {
        if (typeof about === "string") {
          if (about.length > 2000) return json({ error: "\"What I'm responsible for\" is too long; 2000 characters max. Put the rest in the full description" }, 400);
          const f = agentFile(name);
          writeFileSync(f, setDuty(existsSync(f) ? readFileSync(f, "utf8") : "", name, about));
        }
        if (emoji !== undefined) writeLook(name, { emoji: baoEmoji(emoji) || undefined });
        return json({ ok: true });
      }
      if (typeof text !== "string") return json({ error: "Missing text" }, 400);
      writeFileSync(agentFile(name), text);
      return json({ ok: true });
    }

    // Test the API key: uses DeepSeek's /models endpoint, which is free
    if (p === "/api/settings/test" && post) {
      let key: string | undefined;
      try {
        key = await resolvedKey();
      } catch (e) {
        return json({ ok: false, error: `Failed to read API key reference: ${(e as Error).message.split("\n")[0]}` });
      }
      if (!key) return json({ ok: false, error: "No DeepSeek API key entered yet" });
      try {
        const r = await fetch("https://api.deepseek.com/models", {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) return json({ ok: true });
        return json({ ok: false, error: r.status === 401 ? "Wrong API key (401)" : `DeepSeek returned ${r.status}` });
      } catch (e) {
        return json({ ok: false, error: `Can't reach DeepSeek: ${(e as Error).message}` });
      }
    }

    // Restart: under Kiki.app, have launchd restart the service; in dev mode, restart manually
    if (p === "/api/settings/restart" && post) {
      if (!canRestart()) return json({ error: "Dev mode (npm start): please restart manually in the terminal" }, 400);
      json({ ok: true });
      const uid = process.getuid?.() ?? 501;
      setTimeout(() => {
        run("launchctl", ["kickstart", "-k", `gui/${uid}/com.lkyxuan.kiki.en`]).catch(() => process.exit(0));
      }, 300);
      return;
    }

    // Extensions: pi extensions (engine/settings.json) + Kiki's built-in capabilities (features.json)
    if (p === "/api/settings/extensions" && !post) {
      let packages: ReturnType<Extensions["list"]> = [];
      let error: string | undefined;
      try {
        packages = exts.list();
      } catch (e) {
        error = `Can't read engine/settings.json: ${(e as Error).message}`;
      }
      return json({ packages, features: listFeatures(opts.dataDir), error });
    }
    if (p.startsWith("/api/settings/extensions/") && post) {
      const { source, on } = await body();
      if (!validSource(source)) return json({ error: "Source must be npm:package-name, git:repo-url, or https://…" }, 400);
      try {
        const action = p.slice("/api/settings/extensions/".length);
        if (action === "toggle") exts.setOn(source, !!on);
        else if (action === "install") return json({ ok: true, output: await exts.install(source) });
        else if (action === "remove") return json({ ok: true, output: await exts.remove(source) });
        else return json({ error: "not found" }, 404);
        return json({ ok: true });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    // MCP servers: engine/mcp.json
    if (p === "/api/settings/mcp" && !post) {
      try {
        return json({ servers: mcp.list(), file: mcp.file });
      } catch (e) {
        return json({ servers: [], file: mcp.file, error: `Can't read mcp.json: ${(e as Error).message}` });
      }
    }
    if (p.startsWith("/api/settings/mcp/") && post) {
      const { name, spec, on } = await body();
      try {
        const action = p.slice("/api/settings/mcp/".length);
        if (action === "add") return json({ ok: true, name: mcp.add(typeof name === "string" ? name.trim() : "", String(spec ?? "")) });
        if (action === "toggle") mcp.setOn(String(name), !!on);
        else if (action === "remove") mcp.remove(String(name));
        else return json({ error: "not found" }, 404);
        return json({ ok: true });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    }
    // Approval: for each of the four action categories, do it directly (with fallback) / ask first / don't do it, plus rules saved by "always allow from now on"
    if (p === "/api/settings/approval" && !post) return json(listApproval(opts.dataDir));
    if (p === "/api/settings/approval/mode" && post) {
      const { category, mode } = await body();
      try {
        setMode(opts.dataDir, String(category), String(mode));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return json({ ok: true });
    }
    // Mac permissions: list the system permissions to grant and the links to open them
    if (p === "/api/settings/mac-permissions" && !post) return json(await macPerms.status());
    // Request them all at once: prompt slowly in the background (each system dialog waits for you to click), the web page polls the status
    if (p === "/api/settings/mac-permissions/request" && post) {
      void macPerms.requestAll().catch(() => {});
      return json({ ok: true });
    }
    if (p === "/api/settings/mac-permissions/open" && post) {
      try {
        await macPerms.open(String((await body()).id ?? ""));
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return json({ ok: true });
    }
    if (p === "/api/settings/mac-permissions/seen" && post) {
      macPerms.markAsked();
      return json({ ok: true });
    }
    // Full auto fallbacks: outbound send allowlist, ready-to-send delay, spending budget
    if (p === "/api/settings/approval/auto" && post) {
      try {
        setAuto(opts.dataDir, await body());
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return json({ ok: true });
    }
    if (p === "/api/settings/approval/forget" && post) {
      const { key } = await body();
      removeAlways(opts.dataDir, String(key));
      return json({ ok: true });
    }
    if (p === "/api/settings/features" && post) {
      const { id, on } = await body();
      try {
        setFeature(opts.dataDir, id, !!on);
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
      return json({ ok: true });
    }

    json({ error: "not found" }, 404);
  };
}
