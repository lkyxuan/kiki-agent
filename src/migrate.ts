// Data folder upgrade: from "two example bots, dev + life" to "just one default bot, Kiki".
// Runs only once (writes a marker file when done). The old dev and life bots aren't deleted; the whole folder is moved into archive/, and all conversation history is kept.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_BAO = "Kiki";
const MARK = ".migrated-qiqi";
const OLD = ["dev", "life"];

/** Returns what was done (for the log); returns empty if already upgraded. */
export function migrateToQiqi(dataDir: string, templateDir: string, now = new Date()): string[] {
  const done: string[] = [];
  if (existsSync(join(dataDir, MARK))) return done;
  const agentsDir = join(dataDir, "agents");
  mkdirSync(agentsDir, { recursive: true });

  const qiqi = join(agentsDir, DEFAULT_BAO);
  if (!existsSync(qiqi)) {
    cpSync(join(templateDir, "agents", DEFAULT_BAO), qiqi, { recursive: true });
    done.push(`Created the default bot ${DEFAULT_BAO}`);
  }

  const stamp = now.toISOString().slice(0, 10);
  for (const name of OLD) {
    const from = join(agentsDir, name);
    if (!existsSync(from)) continue;
    const to = join(dataDir, "archive", `agents-${stamp}`, name);
    mkdirSync(join(to, ".."), { recursive: true });
    renameSync(from, to);
    done.push(`Old bot ${name} moved to ${to}`);
  }

  // Remove the archived bots' conversations from the registry, and clear the current conversation if it points to them, so routing doesn't deliver to moved files
  const moved = OLD.filter((n) => done.some((l) => l.startsWith(`Old bot ${n} `)));
  const regFile = join(dataDir, "registry.json");
  if (moved.length && existsSync(regFile)) {
    const reg = JSON.parse(readFileSync(regFile, "utf8")) as { sessions?: { agent: string; path: string }[]; chats?: Record<string, string> };
    const gone = new Set((reg.sessions ?? []).filter((x) => moved.includes(x.agent)).map((x) => x.path));
    if (gone.size) {
      reg.sessions = (reg.sessions ?? []).filter((x) => !gone.has(x.path));
      for (const [chat, path] of Object.entries(reg.chats ?? {})) if (gone.has(path)) delete reg.chats![chat];
      writeFileSync(regFile, JSON.stringify(reg, null, 2));
      done.push(`Removed ${gone.size} archived conversations from the conversation registry`);
    }
  }

  // In the routing rules, replace "hand off to Life bot (life)" with Kiki; leave anything else the user changed untouched
  const rules = join(dataDir, "routing-rules.md");
  if (existsSync(rules)) {
    const src = readFileSync(rules, "utf8");
    const next = src.replace("hand it off to Life bot (life)", `hand it off to ${DEFAULT_BAO}`);
    if (next !== src) {
      writeFileSync(rules, next);
      done.push("Changed the default destination in the routing rules to Kiki");
    }
  }

  writeFileSync(join(dataDir, MARK), now.toISOString() + "\n");
  return done;
}

/** The old version of Kiki's instructions (the template from 0.2.7 to 0.2.14): back then Kiki took on everything and had users create their own bots. */
export const OLD_QIQI = "# Kiki: the default bot\n\n## What I'm responsible for\nAnything can come to me first: scheduling, notes, reminders, research, writing, coding.\nWhen there's no better bot, everything lands with me.\n\n## How I work\n- Keep answers short, conclusion first.\n- Things that need to be written down go into notes/ under this folder (one .md per topic).\n- When a certain kind of work piles up (say a long-term project or a fixed domain), suggest the user create a dedicated bot and split it off.\n\n## What I hand back\nGive the answer or result directly, with a one-line reason if needed; list any files changed.\n";

/** If the user hasn't changed Kiki's instructions, swap in the new version (Kiki only routes, and creates a bot itself when none fits); leave changed ones alone. */
export function upgradeQiqiNote(dataDir: string, templateDir: string): string[] {
  const f = join(dataDir, "agents", DEFAULT_BAO, "AGENTS.md");
  if (!existsSync(f) || readFileSync(f, "utf8") !== OLD_QIQI) return [];
  writeFileSync(f, readFileSync(join(templateDir, "agents", DEFAULT_BAO, "AGENTS.md"), "utf8"));
  return ["Swapped in the new version of Kiki's instructions: it only routes, and creates a bot itself when none fits"];
}

/** The old template's "confirm first for irreversible things" line: replace with the full-auto wording (leave it alone if the user changed this line). */
export const OLD_CONFIRM_LINE = "- Only confirm first for outward-facing, irreversible things (sending messages to others on the user's behalf, deleting files, spending money).";
export const NEW_CONFIRM_LINE = "- Deleting, force-pushing, sending externally, and spending money are also done directly: the system backs up automatically first, leaves a short undo window for sends, and manages money by budget, so you don't need to ask the user first.";

export function dropConfirmLine(dataDir: string): string[] {
  const file = join(dataDir, "routing-rules.md");
  if (!existsSync(file)) return [];
  const src = readFileSync(file, "utf8");
  if (!src.includes(OLD_CONFIRM_LINE)) return [];
  writeFileSync(file, src.replace(OLD_CONFIRM_LINE, NEW_CONFIRM_LINE));
  return ["Removed \"confirm first for irreversible things\" from the routing rules: switched to full auto"];
}

/** Add the sections newly added to the template to the routing rules (matched by heading; leave the user's existing sections with the same name alone, and leave everything else alone too). */
export function addRuleSections(dataDir: string, templateDir: string, titles = ["When another bot's business comes up in a conversation"]): string[] {
  const file = join(dataDir, "routing-rules.md");
  if (!existsSync(file)) return [];
  let src = readFileSync(file, "utf8");
  const tpl = readFileSync(join(templateDir, "routing-rules.md"), "utf8");
  const done: string[] = [];
  for (const title of titles) {
    if (src.includes(`## ${title}`)) continue;
    const m = tpl.match(new RegExp(`## ${title}\\n[\\s\\S]*?(?=\\n## |$)`));
    if (!m) continue;
    const section = `${m[0].trim()}\n\n`;
    const at = src.indexOf("## Chat or background");
    src = at >= 0 ? src.slice(0, at) + section + src.slice(at) : `${src.trimEnd()}\n\n${section}`;
    done.push(`Added "${title}" to the routing rules`);
  }
  if (done.length) writeFileSync(file, src);
  return done;
}

/** Butler: the bot that handles Kiki's own affairs (configuration, connecting Claude Code / Codex, and later memory and upgrades). */
export const SETUP_BAO = "Butler";
const SETUP_MARK = ".added-setup-bao";
export const SETUP_PENDING = ".setup-pending"; // If this file exists: on first opening Kiki, the web page goes straight into the Butler's conversation

/** Add the Butler to an old data folder (only once: if you delete it, it won't be recreated). New data folders already have it, copied from the template. */
export function addSetupBao(dataDir: string, templateDir: string): string[] {
  if (existsSync(join(dataDir, SETUP_MARK))) return [];
  writeFileSync(join(dataDir, SETUP_MARK), new Date().toISOString() + "\n");
  const dir = join(dataDir, "agents", SETUP_BAO);
  if (existsSync(dir)) return [];
  mkdirSync(join(dataDir, "agents"), { recursive: true });
  cpSync(join(templateDir, "agents", SETUP_BAO), dir, { recursive: true });
  return [`Added the Butler (${SETUP_BAO}): handles Kiki's own configuration, and is who to ask about connecting Claude Code / Codex`];
}
