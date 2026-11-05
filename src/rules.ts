// Routing rules: user-editable Markdown (~/Kiki/routing-rules.md), read by inbox routing and the handoff tool in conversations.
// Read fresh on every use, so changes take effect without a restart. If the file is missing, use the default version from the repo.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RULES_FILE = "routing-rules.md";
const DEFAULT = join(dirname(fileURLToPath(import.meta.url)), "..", "data-template", RULES_FILE);

export function loadRules(dataDir: string): string {
  for (const f of [join(dataDir, RULES_FILE), DEFAULT]) {
    if (existsSync(f)) return readFileSync(f, "utf8");
  }
  return "Once you've decided, just do it, then tell the user.";
}
