// Conversation registry: keeps track of which named conversations exist, and which conversation each chat is currently attached to.
// Stored as a JSON file; the conversation content itself lives in pi's JSONL, this only holds the index.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface SessionRecord {
  agent: string; // agent folder name, e.g. dev, life
  name: string; // conversation name, unique within the same agent
  path: string; // path to pi's JSONL file
  created: string;
  background?: boolean; // started via /bg
  summary?: string; // one-line summary (30 to 40 characters), updated in the background after each reply; used by routing and the main chat
  active?: string; // time of the most recent answer; used to pick the most recently active conversation
}

interface RegistryData {
  sessions: SessionRecord[];
  chats: Record<string, string>; // chat id -> path of the current conversation
}

export class Registry {
  private data: RegistryData = { sessions: [], chats: {} };

  constructor(private file: string) {
    if (existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file); // write to a temp file first, then rename, to avoid half-written files
  }

  add(rec: SessionRecord) {
    this.data.sessions.push(rec);
    this.save();
  }

  list(agent?: string): SessionRecord[] {
    return this.data.sessions.filter((s) => !agent || s.agent === agent);
  }

  get(agent: string, name: string): SessionRecord | undefined {
    return this.data.sessions.find((s) => s.agent === agent && s.name === name);
  }

  /** Look up by "name" or "agent/name". If the name is duplicated across multiple agents, return all of them so the caller can ask for the fully qualified name. */
  find(query: string): SessionRecord[] {
    const [a, n] = query.includes("/") ? query.split("/", 2) : [undefined, query];
    return this.data.sessions.filter((s) => s.name === n && (!a || s.agent === a));
  }

  byPath(path: string): SessionRecord | undefined {
    return this.data.sessions.find((s) => s.path === path);
  }

  /** Remove a conversation from the registry; any chats attached to it are detached too, so the next message doesn't go to a deleted conversation. */
  remove(path: string): SessionRecord | undefined {
    const rec = this.byPath(path);
    if (!rec) return undefined;
    this.data.sessions = this.data.sessions.filter((s) => s.path !== path);
    for (const [chat, p] of Object.entries(this.data.chats)) if (p === path) delete this.data.chats[chat];
    this.save();
    return rec;
  }

  /** A conversation moved to a new file (used when clearing the main chat): point the registry and any attached chats at the new file. */
  repoint(oldPath: string, newPath: string) {
    const rec = this.byPath(oldPath);
    if (!rec) return;
    rec.path = newPath;
    rec.created = new Date().toISOString();
    delete rec.summary; // cleared, so the old summary no longer applies
    delete rec.active;
    for (const [chat, p] of Object.entries(this.data.chats)) if (p === oldPath) this.data.chats[chat] = newPath;
    this.save();
  }

  /** Record the new summary and active time for this conversation; does nothing if the conversation was deleted or moved to a new file. */
  setSummary(path: string, summary: string | undefined, at = new Date()) {
    const rec = this.byPath(path);
    if (!rec) return;
    if (summary) rec.summary = summary;
    rec.active = at.toISOString();
    this.save();
  }

  current(chatId: string): SessionRecord | undefined {
    const p = this.data.chats[chatId];
    return p ? this.byPath(p) : undefined;
  }

  setCurrent(chatId: string, path: string) {
    this.data.chats[chatId] = path;
    this.save();
  }
}
