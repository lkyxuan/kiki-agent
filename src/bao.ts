// A bot's file layout lives here: what the instruction file is called, and what to write when creating a new bot. Future renames (say, to bao.md) only touch this one place.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Every bot's fixed main chat: this bot's coordinator, which answers simple things directly and spins up threads (the bot's other conversations) for specific work. */
export const MAIN_SESSION = "main chat";

/** Each bot's instruction file (pi reads it into the system prompt). */
export const BAO_FILE = "AGENTS.md";

/** A bot's own skills live in skills/<skill-name>/SKILL.md (Claude / Agent Skills format); Kiki reads them in when a conversation starts. */
export const SKILLS_DIR = "skills";

export const baoDir = (dataDir: string, name: string) => join(dataDir, "agents", name);
export const baoFile = (dataDir: string, name: string) => join(baoDir(dataDir, name), BAO_FILE);

/** Bot name: letters, numbers, - and _, 1 to 12 characters. */
export function validBaoName(name: unknown): name is string {
  return typeof name === "string" && /^[\p{L}\p{N}_-]{1,12}$/u.test(name);
}

/** Create a bot: make the folder, write the instructions. Errors if one already exists. Returns the bot's folder. */
export function createBao(dataDir: string, name: string, duty: string): string {
  if (!validBaoName(name)) throw new Error(`Bot name "${name}" is not allowed: use only letters, numbers, - and _, up to 12 characters`);
  const dir = baoDir(dataDir, name);
  if (existsSync(dir)) throw new Error(`A bot named "${name}" already exists`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(baoFile(dataDir, name), baoDoc(name, duty));
  return dir;
}

/** A new bot's AGENTS.md: "What I'm responsible for" must go under this heading so routing can read it */
export function baoDoc(name: string, duty: string): string {
  const what = duty.replace(/\s*\n\s*/g, " ").trim() || `Anything related to ${name}`;
  return `# ${name}\n\n## What I'm responsible for\n${what}\n\n## How I work\n- Answer briefly, conclusion first.\n- Things worth remembering go in notes/ under this folder (one .md per topic).\n`;
}

// The "## What I'm responsible for" line, plus every line below it up to the next # / ## heading (a heading immediately after also counts)
const DUTY_RE = /(^|\n)##[ \t]*What I'm responsible for[ \t]*(?:\n|$)((?:(?!#{1,2}[ \t])[^\n]*(?:\n|$))*)/;

/** Pull the "What I'm responsible for" section out of AGENTS.md; empty if there isn't one. */
export function readDuty(md: string): string {
  return md.match(DUTY_RE)?.[2].trim() ?? "";
}

/** Replace the "What I'm responsible for" section in AGENTS.md, leaving everything else as is; if there's no such section, add it under the title. */
export function setDuty(md: string, name: string, duty: string): string {
  // May span several lines, but no blank lines and no subheadings (either would break the section)
  const what = duty.split("\n").map((l) => l.trim().replace(/^#+\s*/, "")).filter(Boolean).join("\n") || `Anything related to ${name}`;
  const m = md.match(DUTY_RE);
  if (m && m.index !== undefined) {
    const end = m.index + m[0].length;
    return `${md.slice(0, m.index)}${m[1]}## What I'm responsible for\n${what}\n${end < md.length ? `\n${md.slice(end)}` : ""}`;
  }
  const title = md.match(/^#[ \t]+[^\n]*\n?/);
  if (!title) return `# ${name}\n\n## What I'm responsible for\n${what}\n${md.trim() ? `\n${md}` : ""}`;
  const rest = md.slice(title[0].length).replace(/^\n+/, "");
  return `${title[0].replace(/\n?$/, "\n")}\n## What I'm responsible for\n${what}\n${rest ? `\n${rest}` : ""}`;
}
