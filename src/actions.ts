// "What Kiki did": every dangerous action taken automatically (delete, force push, send externally, spend money) gets a record, and anything undoable gets an undo button.
// It doesn't ask you first, but afterwards you can see it and change it back. Recorded in <data folder>/actions.jsonl, one line per entry; undoing appends a line {id, undone}.
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { undo as runUndo, type Undo } from "./backup.js";

export interface Action {
  id: string;
  time: string;
  agent: string;
  path: string; // which conversation did it
  category: "delete" | "force" | "send" | "spend";
  categoryName: string;
  label: string;
  detail: string;
  note: string; // how it was covered: where it was backed up, how many seconds it waited with no undo, how much money was spent
  undo?: Undo; // absent means it can't be undone (e.g. a message already sent)
  undone?: string; // time of undo
  undoNote?: string;
}

/** Event: change when there's a new record or an undo (web page refresh) */
export class ActionLog extends EventEmitter {
  private seq = 0;
  constructor(readonly dataDir: string) {
    super();
  }
  private get file() {
    return join(this.dataDir, "actions.jsonl");
  }

  add(a: Omit<Action, "id" | "time">): Action {
    const full: Action = { id: `x${Date.now().toString(36)}${(this.seq++).toString(36)}`, time: new Date().toISOString(), ...a };
    mkdirSync(this.dataDir, { recursive: true });
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    this.emit("change");
    return full;
  }

  /** Most recent first */
  list(limit = 50): Action[] {
    if (!existsSync(this.file)) return [];
    const all = new Map<string, Action>();
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const x = JSON.parse(line);
        const had = all.get(x.id);
        all.set(x.id, had ? { ...had, ...x } : x);
      } catch {}
    }
    return [...all.values()].filter((a) => a.time).reverse().slice(0, limit);
  }

  undo(id: string): string {
    const a = this.list(1000).find((x) => x.id === id);
    if (!a) throw new Error("Couldn't find that record");
    if (a.undone) throw new Error("Already undone");
    if (!a.undo) throw new Error("This step can't be undone (e.g. the message has already been sent)");
    const undoNote = runUndo(a.undo);
    appendFileSync(this.file, JSON.stringify({ id, undone: new Date().toISOString(), undoNote }) + "\n");
    this.emit("change");
    return undoNote;
  }
}
