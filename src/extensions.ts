// Managing pi extensions (pi calls them "packages"): installed under <data folder>/engine, listed in the packages field of engine/settings.json.
// Install and remove call Kiki's bundled pi CLI; toggling only changes that entry in the manifest, it doesn't delete files:
//   on:  "npm:pi-web-access"
//   off: {"source": "npm:pi-web-access", "extensions": [], "skills": [], "prompts": [], "themes": []}
// Changes take effect only after starting a new conversation or restarting Kiki.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Entry = string | { source: string; [k: string]: unknown };
const OFF = { extensions: [], skills: [], prompts: [], themes: [] };

const sourceOf = (e: Entry) => (typeof e === "string" ? e : e.source);
export const isOff = (e: Entry) =>
  typeof e !== "string" && Array.isArray(e.extensions) && e.extensions.length === 0 && Array.isArray(e.skills) && e.skills.length === 0;

/** Only accept npm:, git:, and https:// sources, so we don't pass weird arguments to the CLI. */
export const validSource = (s: unknown): s is string =>
  typeof s === "string" && /^(npm:@?[\w.\-/@^~]+|git:[\w.\-/:@~]+|https:\/\/[\w.\-/:@~%]+)$/.test(s) && !s.includes("..");

/** Display name for a package: npm:@scope/name@1.0 → @scope/name, git:github.com/a/b → b */
export function displayName(source: string) {
  if (source.startsWith("npm:")) return source.slice(4).replace(/(.)@[^/]*$/, "$1");
  return source.replace(/\.git$/, "").split("/").pop() || source;
}

export function setEntryOn(packages: Entry[], source: string, on: boolean): Entry[] {
  let found = false;
  const out = packages.map((e) => {
    if (sourceOf(e) !== source) return e;
    found = true;
    // When turning on, restore the simplest form (any resource filters are dropped; the settings page doesn't handle filters)
    return on ? source : { source, ...OFF };
  });
  if (!found) throw new Error(`${source} is not installed`);
  return out;
}

export class Extensions {
  private settingsFile: string;
  constructor(private engineDir: string) {
    this.settingsFile = join(engineDir, "settings.json");
  }

  private read(): Record<string, unknown> {
    return existsSync(this.settingsFile) ? JSON.parse(readFileSync(this.settingsFile, "utf8")) : {};
  }

  list() {
    const pkgs = (this.read().packages as Entry[] | undefined) ?? [];
    return pkgs.map((e) => ({ source: sourceOf(e), name: displayName(sourceOf(e)), on: !isOff(e) }));
  }

  setOn(source: string, on: boolean) {
    const s = this.read();
    s.packages = setEntryOn((s.packages as Entry[] | undefined) ?? [], source, on);
    writeFileSync(this.settingsFile, JSON.stringify(s, null, 2) + "\n");
  }

  install(source: string) {
    return this.pi(["install", source]);
  }

  remove(source: string) {
    return this.pi(["remove", source]);
  }

  /** Run the pi CLI with Kiki's bundled Node, pointing the config directory at engine. Add Node's directory to PATH, since pi needs npm to install npm packages. */
  private pi(args: string[]): Promise<string> {
    // pi only exports ESM (no require condition in exports), so use import.meta.resolve
    const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: this.engineDir,
      PATH: [dirname(process.execPath), process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin"].join(delimiter),
    };
    return new Promise((resolve, reject) =>
      execFile(process.execPath, [cli, ...args], { env, timeout: 180_000, maxBuffer: 4 << 20 }, (err, out, errOut) => {
        const text = `${out}\n${errOut}`.trim().split("\n").slice(-8).join("\n");
        if (err) reject(new Error(text || err.message));
        else resolve(text);
      }),
    );
  }
}
