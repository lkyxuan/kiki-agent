// Toggles for Kiki's built-in capabilities. State lives in <data folder>/features.json and only records what's off: {"route": false}.
// The file is read fresh on every call: change it in settings and the next new conversation picks it up (conversations already open need a Kiki restart).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FEATURES = [
  { id: "route", name: "Auto routing", desc: "The model decides which conversation a one-liner from the inbox joins; when off, it goes to the current conversation or the default bot" },
  { id: "handoff", name: "Hand off new work", desc: "A bot can hand new work to another bot to start a conversation (kiki_handoff)" },
  { id: "peek", name: "Peek at other conversations", desc: "A bot can read what was said in other conversations (kiki_peek)" },
  { id: "relay", name: "Relay a message", desc: "A bot can pass a message along to another conversation (kiki_relay)" },
  { id: "remember", name: "Remember things", desc: "A bot can record things about you in \"About me\" (kiki_remember)" },
  { id: "background", name: "Background tasks", desc: "Work that needs doing runs in the background and reports back when done; when unsure, it finishes using the most reasonable assumption and tells you afterward, stopping to ask only for things in your hands like photos or verification codes; when off, everything is just chat" },
  { id: "schedule", name: "To-dos and schedules", desc: "A bot can record to-dos, scheduled tasks (daily/weekly), and things to do once something else finishes (kiki_task)" },
  { id: "postroom", name: "Mailroom", desc: "Periodically collect messages and check status from external agents (mailbox folders etc.); new messages go to Kiki for routing, and bots can also assign work to them (kiki_outside)" },
] as const;

export type FeatureId = (typeof FEATURES)[number]["id"];

const file = (dataDir: string) => join(dataDir, "features.json");

function read(dataDir: string): Record<string, boolean> {
  try {
    return existsSync(file(dataDir)) ? JSON.parse(readFileSync(file(dataDir), "utf8")) : {};
  } catch {
    return {}; // If the file is corrupted, treat everything as on so Kiki can still start
  }
}

/** Is this capability on? On by default. */
export function isOn(dataDir: string, id: FeatureId): boolean {
  return read(dataDir)[id] !== false;
}

export function listFeatures(dataDir: string) {
  const off = read(dataDir);
  return FEATURES.map((f) => ({ ...f, on: off[f.id] !== false }));
}

export function setFeature(dataDir: string, id: string, on: boolean) {
  if (!FEATURES.some((f) => f.id === id)) throw new Error(`No such capability ${id}`);
  const state = read(dataDir);
  if (on) delete state[id];
  else state[id] = false;
  writeFileSync(file(dataDir), JSON.stringify(state, null, 2) + "\n");
}
