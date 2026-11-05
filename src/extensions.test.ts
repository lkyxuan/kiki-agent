import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { displayName, isOff, setEntryOn, validSource } from "./extensions.js";
import { isOn, listFeatures, setFeature } from "./features.js";

test("extension toggle only changes the matching entry", () => {
  const off = setEntryOn(["npm:a", "npm:b"], "npm:b", false);
  assert.equal(off[0], "npm:a");
  assert.ok(isOff(off[1]));
  assert.deepEqual(setEntryOn(off, "npm:b", true), ["npm:a", "npm:b"]);
  assert.ok(!isOff({ source: "npm:c", extensions: ["x.ts"], skills: [] }));
  assert.throws(() => setEntryOn([], "npm:x", true));
});

test("install source validation", () => {
  assert.ok(validSource("npm:pi-web-access"));
  assert.ok(validSource("npm:@scope/pkg@1.2.3"));
  assert.ok(validSource("git:github.com/a/b@v1"));
  assert.ok(!validSource("npm:a; rm -rf ~"));
  assert.ok(!validSource("--foo"));
  assert.ok(!validSource("./local"));
  assert.ok(!validSource("npm:../x"));
});

test("display name", () => {
  assert.equal(displayName("npm:pi-web-access"), "pi-web-access");
  assert.equal(displayName("npm:@scope/pkg@1.2.3"), "@scope/pkg");
  assert.equal(displayName("git:github.com/a/b"), "b");
});

test("feature toggles default to on, only disabled ones are recorded", () => {
  const d = mkdtempSync(join(tmpdir(), "kiki-"));
  assert.ok(isOn(d, "route"));
  setFeature(d, "route", false);
  assert.ok(!isOn(d, "route"));
  assert.equal(listFeatures(d).find((f) => f.id === "route")?.on, false);
  setFeature(d, "route", true);
  assert.ok(isOn(d, "route"));
  assert.throws(() => setFeature(d, "nope", false));
});
