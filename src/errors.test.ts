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
  assert.match(explainError('No API key found for "anthropic"'), /You're not signed in to anthropic and no API key is set for it/);
});

test("Wrong API key, insufficient balance", () => {
  assert.match(explainError("401 Authentication Fails, Your api key: ****abcd is invalid"), /API key is wrong or has expired/);
  assert.match(explainError("402 Insufficient Balance"), /balance is too low/);
});

test("Unrecognized errors are returned as-is", () => {
  assert.equal(explainError("Connection error."), "Connection error.");
});
