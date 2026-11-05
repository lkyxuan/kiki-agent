import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pickedIds, readPrefs, setProviderModels, setProviderOn } from "./modelprefs.js";

test("model menu toggles and selections", () => {
  const dir = mkdtempSync(join(tmpdir(), "kiki-prefs-"));
  assert.deepEqual(readPrefs(dir), { off: [], models: {} });
  const few = ["a", "b"], many = Array.from({ length: 20 }, (_, i) => `m${i}`);
  assert.deepEqual([...pickedIds(readPrefs(dir), "x", few)], few); // if there aren't many, list them all
  assert.equal(pickedIds(readPrefs(dir), "y", many).size, 8); // if there are many, list 8 first
  setProviderOn(dir, "y", false);
  assert.deepEqual(readPrefs(dir).off, ["y"]);
  setProviderOn(dir, "y", true);
  assert.deepEqual(readPrefs(dir).off, []);
  setProviderModels(dir, "y", ["m3", "m15", "gone"]);
  assert.deepEqual([...pickedIds(readPrefs(dir), "y", many)].sort(), ["m15", "m3"]); // models that no longer exist don't count
});
