import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffTool } from "./handoff.js";

test("the handoff tool's prompt includes the bot directory: each bot's name and a one-line responsibility", () => {
  const t = handoffTool({ listBaos: () => ["Kiki", "Life bot"], describe: (b) => (b === "Life bot" ? "Daily life" : ""), onHandoff: async () => "" });
  const dir = (t.promptGuidelines ?? []).find((g) => g.startsWith("Existing bots:"));
  assert.equal(dir, "Existing bots:\n- Kiki\n- Life bot: Daily life\nTo see which conversations each bot has and where they stand, use kiki_peek.");
});
