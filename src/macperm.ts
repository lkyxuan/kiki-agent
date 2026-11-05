// Mac permissions: the system permissions Kiki needs to get things done. Ask for them all at once the first time it opens, so work doesn't get stuck on a system prompt — or worse, a prompt that never appears.
//
// Who's asking: the real work is done by "Kiki Agent" (Contents/Helpers/KikiAgent.app, which bundles its own Node and is run by launchd),
// so all permissions go to it; System Settings shows it as "Kiki Agent". It's developer-signed with a fixed identifier, so permissions survive auto-updates.
//
// How to ask: all of this happens on the Mac running Kiki (when connected remotely, that's the remote Mac), and the requests are made by the agent itself so the system prompts are attributed to it:
//   - Accessibility, Screen Recording: call the system's "request" APIs, which show the system dialogs
//   - Automation (Calendar, Reminders, Notes, Contacts, Finder, System Events): send each app a harmless AppleEvent, and the system asks "allow control"
//   - Full Disk Access: Apple doesn't provide a prompt, so we can only open that System Settings pane and point out "Kiki Agent" in Finder — just drag it in
//   - Local Network: the system asks on its own the first time you connect to the local network
// Apple requires the user to flip these switches by hand; all we can do is bring up every prompt at once and open every settings pane.
import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PANE = "x-apple.systempreferences:com.apple.preference.security?";
type Status = "on" | "off" | "unknown";
interface Perm {
  id: string;
  name: string;
  why: string;
  url: string;
  /** Automation: the app to control */
  app?: string;
}

export const MAC_PERMISSIONS: Perm[] = [
  { id: "files", name: "Full Disk Access", why: "Read and write all your files, including Documents, Downloads, Mail and Notes data", url: `${PANE}Privacy_AllFiles` },
  { id: "accessibility", name: "Accessibility", why: "Click buttons for you and type in other apps", url: `${PANE}Privacy_Accessibility` },
  { id: "screen", name: "Screen Recording", why: "Take a look at what's on screen when needed", url: `${PANE}Privacy_ScreenCapture` },
  { id: "ae-system", name: "Automation: System Events", why: "Work with windows, menus and System Settings", url: `${PANE}Privacy_Automation`, app: "System Events" },
  { id: "ae-finder", name: "Automation: Finder", why: "Organize files and open folders", url: `${PANE}Privacy_Automation`, app: "Finder" },
  { id: "ae-calendar", name: "Automation: Calendar", why: "See your schedule and help you set up meetings", url: `${PANE}Privacy_Automation`, app: "Calendar" },
  { id: "ae-reminders", name: "Automation: Reminders", why: "See and add your to-dos", url: `${PANE}Privacy_Automation`, app: "Reminders" },
  { id: "ae-notes", name: "Automation: Notes", why: "Take notes and look them up", url: `${PANE}Privacy_Automation`, app: "Notes" },
  { id: "ae-contacts", name: "Automation: Contacts", why: "Recognize who sent a message or email", url: `${PANE}Privacy_Automation`, app: "Contacts" },
  { id: "network", name: "Local Network", why: "Connect to another computer on your local network or Tailscale (the system asks the first time you connect)", url: `${PANE}Privacy_LocalNetwork` },
];

type Run = (cmd: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; out: string; err: string }>;
const run: Run = (cmd, args, timeoutMs) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: timeoutMs }, (e, out, err) => resolve({ ok: !e, out: String(out ?? "").trim(), err: String(err ?? "") })),
  );

const jxa = (code: string, timeoutMs = 10_000, r: Run = run) => r("osascript", ["-l", "JavaScript", "-e", code], timeoutMs);

/** Where the "Kiki Agent" helper app is (undefined when Kiki was started from the command line) */
export function agentApp(execPath = process.execPath): string | undefined {
  const m = execPath.match(/^(.*\/KikiAgent\.app)\//);
  return m ? m[1] : undefined;
}

export class MacPermissions {
  private requesting = false;
  private step = "";

  constructor(
    readonly dataDir: string,
    private platform = process.platform,
    private home = homedir(),
    private r: Run = run,
  ) {}

  private get file() {
    return join(this.dataDir, "mac-permissions.json");
  }
  private load(): { asked?: string; results: Record<string, Status> } {
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      return { asked: s.asked, results: s.results ?? {} };
    } catch {
      return { results: {} };
    }
  }
  private save(s: { asked?: string; results: Record<string, Status> }) {
    writeFileSync(this.file, JSON.stringify(s, null, 2) + "\n");
  }

  /** Full Disk Access: if the system's privacy database can be opened, it's granted */
  private files(): Status {
    try {
      closeSync(openSync(join(this.home, "Library/Application Support/com.apple.TCC/TCC.db"), "r"));
      return "on";
    } catch (e: any) {
      return e?.code === "EPERM" || e?.code === "EACCES" ? "off" : "unknown";
    }
  }

  /** Accessibility, Screen Recording: the system has silent query APIs */
  private async probe(id: string): Promise<Status> {
    const code =
      id === "accessibility"
        ? 'ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()'
        : id === "screen"
          ? 'ObjC.import("CoreGraphics"); $.CGPreflightScreenCaptureAccess()'
          : "";
    if (!code) return "unknown";
    const x = await jxa(code, 10_000, this.r);
    return x.ok ? (x.out === "true" ? "on" : "off") : "unknown";
  }

  async status() {
    if (this.platform !== "darwin") return { mac: false as const, items: [] };
    const saved = this.load();
    const items = [];
    for (const p of MAC_PERMISSIONS) {
      let status: Status = saved.results[p.id] ?? "unknown";
      if (p.id === "files") status = this.files();
      else if (p.id === "accessibility" || p.id === "screen") status = await this.probe(p.id);
      items.push({ ...p, status });
    }
    return {
      mac: true as const,
      asked: !!saved.asked, // Not yet asked on first open: the web page opens this pane automatically
      requesting: this.requesting,
      step: this.step,
      agent: agentApp(),
      items,
    };
  }

  /** Ask for everything at once: bring up every system prompt in order (each one waits for you to finish before the next), then open the Full Disk Access pane */
  async requestAll(): Promise<void> {
    if (this.platform !== "darwin" || this.requesting) return;
    this.requesting = true;
    const saved = this.load();
    saved.asked = new Date().toISOString();
    this.save(saved);
    try {
      this.step = "Accessibility";
      await jxa('ObjC.import("ApplicationServices"); $.AXIsProcessTrustedWithOptions($({AXTrustedCheckOptionPrompt: true}))', 10_000, this.r);
      this.step = "Screen Recording";
      await jxa('ObjC.import("CoreGraphics"); $.CGRequestScreenCaptureAccess()', 10_000, this.r);
      for (const p of MAC_PERMISSIONS.filter((x) => x.app)) {
        this.step = p.name;
        // A harmless question: just read the app's name. The first time, the system asks "Allow Kiki Agent to control X?", waiting up to two minutes
        const x = await this.r("osascript", ["-e", `tell application "${p.app}" to get name`], 120_000);
        saved.results[p.id] = x.ok ? "on" : /-1743|Not authori[sz]ed|not allowed/i.test(x.err) ? "off" : "unknown";
        this.save(saved);
      }
      if (this.files() !== "on") {
        this.step = "Full Disk Access";
        await this.open("files");
      }
    } finally {
      this.requesting = false;
      this.step = "";
    }
  }

  /** Open the matching System Settings pane on the Mac running Kiki; for Full Disk Access, also reveal "Kiki Agent" in Finder so it can be dragged into the list */
  async open(id: string): Promise<void> {
    const p = MAC_PERMISSIONS.find((x) => x.id === id);
    if (!p) throw new Error(`No such permission ${id}`);
    if (this.platform !== "darwin") throw new Error("Kiki isn't running on a Mac right now");
    await this.r("open", [p.url], 10_000);
    const agent = agentApp();
    if (id === "files" && agent && existsSync(agent)) await this.r("open", ["-R", agent], 10_000);
  }

  markAsked() {
    const s = this.load();
    s.asked ??= new Date().toISOString();
    this.save(s);
  }
}

export const agentDir = (execPath = process.execPath) => {
  const a = agentApp(execPath);
  return a ? dirname(a) : undefined;
};
