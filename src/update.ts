// Auto-update. The approach mirrors Hermes' `hermes update`:
//   check for a new version in the background → download to a staging area → self-check before replacing → back up state files before replacing → restart → auto-rollback if it won't start → leave a receipt.
// Difference from Hermes: Hermes is a git repo and uses git pull; Kiki is installed as Kiki.app with no git,
// so it downloads the prebuilt zip from GitHub Releases (see packaging/build.sh and .github/workflows/release.yml for the build).
//
// It only replaces itself when launched from Kiki.app (the launcher sets KIKI_APP); in npm start dev mode it only shows a notice and leaves the code alone.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HOUR = 3600_000;

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION: string = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "installing" | "error";

export interface UpdateState {
  current: string;
  latest?: string;
  notes?: string;
  url?: string; // release page
  status: UpdateStatus;
  message?: string;
  /** The current step and its progress, used by the settings page to draw a progress bar: 1 download → 2 verify → 3 self-check → 4 back up → 5 wait for conversations to finish → 6 swap and restart */
  step?: { n: number; of: number; label: string; percent?: number };
  checkedAt?: string;
  canApply: boolean; // only when running from Kiki.app can it replace itself
  auto: boolean; // install automatically when idle
  last?: { from: string; to: string; result: string; at: string }; // receipt from the last update
}

/** "0.10.1" > "0.9.3". Compares numeric segments only, ignoring suffixes like -beta. */
export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x) || 0);
  const pb = b.replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** Find the checksum for a file in the text of SHA256SUMS. */
export function sumFor(sums: string, file: string): string | undefined {
  for (const line of sums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    if (name === file) return hash.toLowerCase();
  }
}

export const assetName = (arch = process.arch) => `Kiki-mac-${arch}.zip`;

export class Updater extends EventEmitter {
  readonly repo = process.env.KIKI_UPDATE_REPO || "lkyxuan/kiki-agent";
  readonly api = process.env.KIKI_UPDATE_API || "https://api.github.com"; // can point at a fake server in tests
  readonly appPath = process.env.KIKI_APP; // .../Kiki.app
  readonly logDir = join(homedir(), "Library", "Logs", "Kiki");
  private release?: { tag: string; assets: { name: string; url: string }[] };
  private lastCheck = 0;
  private lastBusyLog = ""; // the last "why it hasn't installed yet" written to the log; the same reason is logged only once an hour
  private lastBusyLogAt = 0;
  state: UpdateState;

  constructor(
    private opts: { dataDir: string; port: number; whyBusy: () => string | undefined; maxWaitMs?: number },
  ) {
    super();
    this.state = {
      current: VERSION,
      status: "idle",
      canApply: !!this.appPath && process.platform === "darwin",
      auto: process.env.KIKI_AUTO_UPDATE !== "0",
    };
    this.readReceipt();
  }

  /** Log one line per step to ~/Library/Logs/Kiki/update.log (the same file the swap script swap.sh writes to), visible under "Details" in the settings page. */
  log(text: string) {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(join(this.logDir, "update.log"), `[${ts}] ${text}\n`);
    } catch {}
  }

  /** The last n lines of update.log. */
  logTail(n = 80): string[] {
    try {
      return readFileSync(join(this.logDir, "update.log"), "utf8").trimEnd().split("\n").slice(-n);
    } catch {
      return [];
    }
  }

  readReceipt() {
    try {
      this.state.last = JSON.parse(readFileSync(join(this.logDir, "last-update.json"), "utf8"));
    } catch {}
  }

  private set(patch: Partial<UpdateState>) {
    Object.assign(this.state, patch);
    this.emit("state", this.state);
  }

  /** Check once at startup, then look every 10 minutes: re-check once an hour has passed since the last check; if a new version exists and we're idle, install it automatically. */
  start() {
    if (process.env.KIKI_UPDATE_CHECK === "0") return;
    const tick = async () => {
      // The post-rollback receipt is only written after the old version comes back up, so read it fresh every time
      this.readReceipt();
      if (Date.now() - this.lastCheck > HOUR) await this.check().catch(() => {});
      // If installing this version failed and rolled back last time, don't retry automatically; wait for a manual click
      const failedBefore = this.state.last?.result.startsWith("roll") && this.state.last.to === this.state.latest;
      if (this.state.status === "available" && this.state.auto && this.state.canApply && !failedBefore) {
        const why = this.opts.whyBusy();
        if (!why) await this.apply().catch(() => {});
        else if (why !== this.lastBusyLog || Date.now() - this.lastBusyLogAt > HOUR) {
          this.lastBusyLog = why;
          this.lastBusyLogAt = Date.now();
          this.log(`New version ${this.state.latest} available, will install when idle: ${why}`);
        }
      }
    };
    setTimeout(tick, 20_000); // don't compete with startup
    setInterval(tick, 10 * 60_000).unref();
  }

  /** Private repos need a token: check the environment variables first, then borrow gh's login (same order as Hermes). Public repos can skip it. */
  private async token(): Promise<string | undefined> {
    const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (env) return env;
    for (const gh of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
      try {
        const { stdout } = await run(gh, ["auth", "token"], { timeout: 5000 });
        if (stdout.trim()) return stdout.trim();
      } catch {}
    }
  }

  private async gh(url: string, accept = "application/vnd.github+json") {
    const token = await this.token();
    const init = {
      headers: {
        accept,
        "user-agent": `kiki/${VERSION}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    };
    // The network occasionally hiccups ("fetch failed"); retry twice, and if it still fails, log the underlying cause and report it
    let res!: Response;
    for (let i = 0; ; i++) {
      try {
        res = await fetch(url, init);
        break;
      } catch (e) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const why = cause?.code || cause?.message || "";
        console.error(`[update] Failed to reach GitHub (attempt ${i + 1}): ${(e as Error).message}${why ? ` (${why})` : ""}`);
        if (i >= 2) throw new Error(`Can't reach GitHub${why ? ` (${why})` : ""}`);
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    if (!res.ok) {
      if (res.status === 404)
        throw new Error(token ? "No release has been published yet" : "No release found (private repos need GITHUB_TOKEN or a gh login)");
      throw new Error(`GitHub returned ${res.status}`);
    }
    return res;
  }

  async check(): Promise<UpdateState> {
    if (["checking", "downloading", "installing"].includes(this.state.status)) return this.state;
    this.set({ status: "checking", message: undefined });
    this.lastCheck = Date.now();
    try {
      const r = (await (await this.gh(`${this.api}/repos/${this.repo}/releases/latest`)).json()) as {
        tag_name: string;
        body?: string;
        html_url: string;
        assets: { name: string; url: string }[];
      };
      this.release = { tag: r.tag_name, assets: r.assets };
      const latest = r.tag_name.replace(/^v/, "");
      const has = newer(latest, VERSION);
      this.log(has ? `Checking for updates: new version ${latest} found (current ${VERSION})` : `Checking for updates: already up to date (${VERSION})`);
      this.set({
        latest,
        notes: r.body?.slice(0, 2000),
        url: r.html_url,
        status: has ? "available" : "idle",
        checkedAt: new Date().toISOString(),
      });
    } catch (e) {
      this.log(`Update check failed: ${(e as Error).message}`);
      this.set({ status: "error", message: `Update check failed: ${(e as Error).message}`, checkedAt: new Date().toISOString() });
    }
    return this.state;
  }

  async apply(): Promise<UpdateState> {
    if (!this.state.canApply) throw new Error("Dev mode (npm start) doesn't replace code automatically; update with git pull");
    // Already installing (e.g. the background auto-update just started, or the button was clicked twice): don't error, return the current progress
    if (["downloading", "installing"].includes(this.state.status)) return this.state;
    if (this.state.status !== "available" || !this.release) throw new Error("There's no new version to install right now");
    const app = this.appPath!;
    const to = this.state.latest!;
    const zipAsset = this.release.assets.find((a) => a.name === assetName());
    const sumAsset = this.release.assets.find((a) => a.name === "SHA256SUMS");
    if (!zipAsset || !sumAsset) {
      this.set({ status: "error", message: `Release ${this.release.tag} doesn't contain ${assetName()}` });
      return this.state;
    }

    const work = join(tmpdir(), `kiki-update-${to}`);
    const staging = join(dirname(app), ".Kiki-update"); // same volume as the app, so the swap is an instant rename
    try {
      // 1. Download and verify
      this.set({ status: "downloading", message: `Downloading ${to}…`, step: undefined });
      // Clean up downloads left in the temp folder by previous updates (tens of MB each)
      for (const d of readdirSync(tmpdir())) {
        if (d.startsWith("kiki-update-")) rmSync(join(tmpdir(), d), { recursive: true, force: true });
      }
      mkdirSync(work, { recursive: true });
      const zip = join(work, zipAsset.name);
      const STEPS = 6;
      const step = (n: number, label: string, percent?: number) => {
        if (percent === undefined || percent === 0) this.log(`Step ${n}/${STEPS}: ${label}`);
        this.set({ step: { n, of: STEPS, label, percent }, message: `${label}…` });
      };
      this.log(`Preparing update ${VERSION} → ${to}`);
      step(1, `Downloading ${to}`, 0);
      const t0 = Date.now();
      const res = await this.gh(zipAsset.url, "application/octet-stream");
      const total = Number(res.headers.get("content-length")) || 0;
      const hash = createHash("sha256");
      let got = 0;
      let shown = -1;
      await pipeline(
        Readable.fromWeb(res.body as never),
        async function* (this: void, src) {
          for await (const chunk of src) {
            hash.update(chunk);
            got += chunk.length;
            const pct = total ? Math.floor((got / total) * 100) : undefined;
            if (pct !== undefined && pct !== shown) {
              shown = pct;
              const mbps = got / 1048576 / Math.max(0.001, (Date.now() - t0) / 1000);
              step(1, `Downloading ${to} (${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB, ${mbps.toFixed(1)} MB/s)`, pct || 1);
            }
            yield chunk;
          }
        },
        createWriteStream(zip),
      );
      const secs = (Date.now() - t0) / 1000;
      this.log(`Download complete: ${(got / 1048576).toFixed(1)} MB in ${secs.toFixed(1)} seconds, averaging ${(got / 1048576 / Math.max(0.001, secs)).toFixed(1)} MB/s`);
      step(2, "Verifying checksum");
      const sums = await (await this.gh(sumAsset.url, "application/octet-stream")).text();
      const want = sumFor(sums, zipAsset.name);
      if (!want || want !== hash.digest("hex")) throw new Error("Checksum mismatch, giving up");
      this.log("Checksum matches");

      // 2. Unzip into the staging area and run a self-check with the new version's bundled Node (the equivalent of Hermes compiling key files after an update)
      this.set({ status: "installing" });
      step(3, `Unzipping and self-checking ${to}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      await run("/usr/bin/ditto", ["-x", "-k", zip, staging]);
      const staged = join(staging, "Kiki.app");
      // If the running copy is signed by a developer, only accept a new version signed by the same developer (team ID) with an intact signature, so nobody can impersonate it.
      // The current locally signed build has no team ID, so it isn't checked, which lets it upgrade smoothly to the first signed build.
      const mine = await signedTeam(app);
      if (mine) {
        // Can't just compare the displayed team ID (a self-signed cert can put the same text there): require the chain to reach Apple, a Developer ID, and a matching team
        await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${developerIdRequirement(mine)}`, staged]).catch(() => {
          throw new Error(`The new version isn't signed by team ${mine} with an Apple-issued Developer ID certificate, or its signature is incomplete; giving up`);
        });
        this.log(`Signature verified (team ${mine}, Apple-issued Developer ID)`);
      }
      const res2 = join(staged, "Contents", "Resources");
      const { stdout } = await run(join(res2, "node", "bin", "node"), [join(res2, "app", "dist", "main.js"), "--selftest"], {
        timeout: 60_000,
      });
      if (!stdout.includes(`kiki ${to} ok`)) throw new Error(`New version failed its self-test: ${stdout.slice(0, 200)}`);
      this.log(`New version passed self-test (${stdout.trim()})`);

      // 3. Back up state files (small files only; conversations aren't touched by the update)
      step(4, "Backing up settings");
      this.backup();

      // 4. Wait for in-flight conversations to finish before switching (new ones may start during download and self-test).
      //    The idle check and launching the swap script are synchronous, so no new message can slip in between.
      //    Wait at most 30 minutes: if it never goes idle (e.g. a conversation is stuck), give up on this attempt and go back to "new version available",
      //    so the next round can still find newer versions and install once idle, instead of getting stuck here forever and never finding new versions again.
      const waitStart = Date.now();
      const maxWait = this.opts.maxWaitMs ?? 30 * 60_000;
      let why: string | undefined;
      let logged = "";
      while ((why = this.opts.whyBusy())) {
        if (why !== logged) this.log(`${to} is ready, waiting for idle to switch: ${why}`);
        logged = why;
        if (Date.now() - waitStart > maxWait) {
          rmSync(staging, { recursive: true, force: true });
          this.log(`Waited ${Math.round(maxWait / 60_000)} minutes and still not idle (${why}); skipping this install, will retry when idle`);
          this.set({ status: "available", message: `Will install when idle: ${why}`, step: undefined });
          return this.state;
        }
        step(5, `${to} is ready, switching once current work finishes (${why})`);
        await new Promise((r) => setTimeout(r, 5000));
      }

      // 5. Hand off to the swap script in the old version: swap App → restart → health check → roll back if it fails. It will restart the current process.
      const script = join(work, "swap.sh");
      copyFileSync(join(app, "Contents", "Resources", "swap.sh"), script);
      mkdirSync(this.logDir, { recursive: true });
      const log = openSync(join(this.logDir, "update.log"), "a");
      spawn("/bin/bash", [script, app, staged, VERSION, to, String(this.opts.port), this.logDir], {
        detached: true,
        stdio: ["ignore", log, log],
      }).unref();
      step(6, `Switching to ${to}, Kiki will restart for a few seconds`);
    } catch (e) {
      rmSync(staging, { recursive: true, force: true });
      this.log(`Update failed: ${(e as Error).message}`);
      this.set({ status: "error", message: `Update failed: ${(e as Error).message}`, step: undefined });
    }
    return this.state;
  }

  private backup() {
    const dir = join(this.opts.dataDir, "backups");
    const dest = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-v${VERSION}`);
    mkdirSync(dest, { recursive: true });
    for (const f of ["registry.json", "AGENTS.md", ".env", "main.jsonl"]) {
      const src = join(this.opts.dataDir, f);
      if (existsSync(src)) copyFileSync(src, join(dest, f));
    }
    // Keep only the 5 most recent
    const all = readdirSync(dir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 5))) rmSync(join(dir, old), { recursive: true, force: true });
  }
}

/** Extract the team ID from `codesign -dv` output; local (ad-hoc) signatures show "not set", so return undefined. */
export function teamIdFrom(codesignOutput: string): string | undefined {
  const m = /^TeamIdentifier=(\S+)\s*$/m.exec(codesignOutput);
  return m && m[1] !== "not" ? m[1] : undefined;
}

/** Signing requirement (for codesign -R) that only accepts an Apple-issued Developer ID Application certificate belonging to this team. */
export function developerIdRequirement(team: string): string {
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error(`Invalid team ID format: ${team}`);
  return (
    "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists" +
    ` and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`
  );
}

/** The App's developer team ID; returns undefined if unsigned, locally signed, or not on a Mac. */
async function signedTeam(app: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await run("/usr/bin/codesign", ["-dv", "--verbose=2", app]);
    return teamIdFrom(stderr + stdout);
  } catch {
    return undefined;
  }
}
