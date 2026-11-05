// Which models show up in the model menu: one toggle per provider, and for each enabled provider, which models to check.
// Stored in <data folder>/models-menu.json: { off: [providers], models: { provider: [model ids] } }.
// Providers never configured: if there aren't many models (≤10) list them all, otherwise list the first 8 and pick more in settings.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MenuPrefs {
  off: string[];
  models: Record<string, string[]>;
}

export const DEFAULT_PICK = 8;

export function readPrefs(dataDir: string): MenuPrefs {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, "models-menu.json"), "utf8"));
    return { off: Array.isArray(j.off) ? j.off.map(String) : [], models: j.models && typeof j.models === "object" ? j.models : {} };
  } catch {
    return { off: [], models: {} };
  }
}

export function writePrefs(dataDir: string, p: MenuPrefs) {
  writeFileSync(join(dataDir, "models-menu.json"), JSON.stringify(p, null, 2) + "\n");
}

/** Which of this provider's models go in the menu (ids are all of this provider's models, in catalog order). */
export function pickedIds(p: MenuPrefs, provider: string, ids: string[]): Set<string> {
  const chosen = p.models[provider];
  if (chosen) return new Set(chosen.filter((id) => ids.includes(id)));
  return new Set(ids.length <= 10 ? ids : ids.slice(0, DEFAULT_PICK));
}

export function setProviderOn(dataDir: string, provider: string, on: boolean) {
  const p = readPrefs(dataDir);
  p.off = p.off.filter((x) => x !== provider);
  if (!on) p.off.push(provider);
  writePrefs(dataDir, p);
}

export function setProviderModels(dataDir: string, provider: string, ids: string[]) {
  const p = readPrefs(dataDir);
  p.models[provider] = [...new Set(ids.map(String))];
  writePrefs(dataDir, p);
}
