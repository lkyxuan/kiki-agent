import assert from "node:assert/strict";
import { test } from "node:test";
import { explainError } from "./errors.js";

test("DeepSeek API key not set: points to the settings page, without a node_modules path", () => {
  const raw = "No API key found for deepseek.\n\nUse /login to log into a provider via OAuth or API key. See:\n/x/node_modules/@earendil-works/pi-coding-agent/docs/providers.md";
  const out = explainError(raw);
  assert.match(out, /No model API key yet/);
  assert.match(out, /Settings → Providers/);
  assert.doesNotMatch(out, /node_modules|\/login/);
  assert.match(explainError("Provider is not configured: deepseek"), /No model API key yet/);
});

test("Another provider not configured: says which one", () => {
  assert.match(explainError('No API key found for "anthropic"'), /Not signed in to anthropic yet/);
});

test("Wrong API key, insufficient balance", () => {
  assert.match(explainError("401 Authentication Fails, Your api key: ****abcd is invalid"), /API key is incorrect/);
  assert.match(explainError("402 Insufficient Balance"), /Insufficient balance/);
});

test("Unrecognized errors are returned as-is", () => {
  assert.equal(explainError("Connection error."), "Connection error.");
});
