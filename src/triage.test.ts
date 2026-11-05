import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeTriage, openItems, parseVerdict, unwatchTask, watchForTask, Watchlist } from "./triage.js";
import type { InboxItem } from "./postroom.js";

const item = (text: string, title?: string): InboxItem => ({ id: "x", from: "Mailbox", received: "", text, title, status: "new" });
const today = () => `${new Date().getMonth() + 1}/${new Date().getDate()}`;

function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "kiki-tr-"));
  for (const b of ["Crypto bot", "Life bot"]) mkdirSync(join(dataDir, "agents", b), { recursive: true });
  const calls: { sys: string; user: string }[] = [];
  let answers: string[] = [];
  const triage = makeTriage({
    dataDir,
    listBaos: () => ["Crypto bot", "Life bot"],
    describe: (b) => (b === "Crypto bot" ? "crypto, exchange accounts" : "daily life, bills"),
    complete: async (sys, user) => (calls.push({ sys, user }), answers.shift() ?? "{}"),
  });
  return { dataDir, triage, calls, answer: (...a: string[]) => (answers = a) };
}

test("triage result: only fields in the JSON are recognized", () => {
  const v = parseVerdict('Sure: {"important":true,"why":"login from a new location","route":false,"add":"Binance account anomaly","keys":["Binance","Binance"],"done":[2],"related":[1]}');
  assert.equal(v?.important, true);
  assert.deepEqual(v?.keys, ["Binance", "Binance"]);
  assert.deepEqual(v?.related, [1]);
  assert.equal(parseVerdict("can't parse this"), undefined);
});

test("first read each bot's description to route to a bot; a bot only reads its own watchlist; new items go into that bot's watchlist with keywords", async () => {
  const { dataDir, triage, calls, answer } = setup();
  new Watchlist(dataDir, "Life bot").add("electricity bill payment failed");
  answer('{"bao":"Crypto bot"}', '{"important":true,"why":"Binance flagged a login from a new location","route":false,"add":"Binance account anomaly, pending confirmation of compromise","keys":["Binance","Binance"]}');
  const v = await triage(item("Your account logged in on a new device", "Binance security alert"));
  assert.equal(v?.bao, "Crypto bot");
  assert.match(calls[0].user, /Crypto bot: crypto/);
  assert.doesNotMatch(calls[1].user, /electricity/); // did not read Life bot's watchlist
  const items = new Watchlist(dataDir, "Crypto bot").open();
  assert.deepEqual(items.map((w) => [w.text, w.keys]), [[`Binance account anomaly, pending confirmation of compromise (since ${today()} · Mailbox)`, ["Binance", "Binance"]]]);
});

test("keyword hit picks the bot directly (no model selection); matches to prior context get crossed off; items tied to a conversation or task are handed back", async () => {
  const { dataDir, triage, calls, answer } = setup();
  const wl = new Watchlist(dataDir, "Crypto bot");
  wl.add("Binance account anomaly", { keys: ["Binance"] });
  wl.add("Signed up for an on-chain hackathon, waiting for the organizer's follow-up", { keys: ["hackathon"], session: "Crypto bot/signup", task: "t9" });
  wl.add("another thing unrelated to the exchange", { keys: ["unrelated"] });
  answer('{"important":false,"why":"Binance confirmed it was safe; hackathon needs more materials","route":false,"done":[1],"doneWhy":"confirmed it was me logging in","related":[2]}');
  const v = await triage(item("Binance: account restored. Also: the hackathon needs additional materials submitted"));
  assert.equal(calls.length, 1); // called only once (the judgment); bot selection relies on keywords
  assert.doesNotMatch(calls[0].user, /another thing/); // entries with no keyword hit are not shown to the model
  assert.deepEqual(v?.crossed, [`Binance account anomaly (since ${today()})`]);
  assert.deepEqual(v?.follow, [{ text: `Signed up for an on-chain hackathon, waiting for the organizer's follow-up (since ${today()})`, link: "Crypto bot/signup", task: "t9" }]);
  assert.match(readFileSync(wl.file, "utf8"), /- \[x\] Binance account anomaly.*resolved: confirmed it was me logging in/);
});

test("task follow-up: written into the owning bot's watchlist, crossed off when cancelled", () => {
  const { dataDir } = setup();
  watchForTask(dataDir, { taskId: "t1", agent: "Life bot", about: "waiting for the landlord to reply about the deposit", match: "landlord,deposit", session: "Life bot/deposit" });
  const w = new Watchlist(dataDir, "Life bot").open()[0];
  assert.deepEqual([w.task, w.link, w.keys], ["t1", "Life bot/deposit", ["landlord", "deposit"]]);
  unwatchTask(dataDir, ["Crypto bot", "Life bot"], "t1");
  assert.equal(new Watchlist(dataDir, "Life bot").open().length, 0);
  assert.equal(openItems("- [ ] a hand-written entry").length, 1);
});

test("if the model errors, return empty and let the Mailroom hand it to Kiki the old way", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "kiki-tr-"));
  const triage = makeTriage({ dataDir, listBaos: () => [], describe: () => "", complete: async () => { throw new Error("no API key"); } });
  assert.equal(await triage(item("x")), undefined);
});
