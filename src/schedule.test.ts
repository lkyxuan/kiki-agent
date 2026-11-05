import assert from "node:assert/strict";
import { test } from "node:test";
import { nextRun, parseWhen, showTime } from "./schedule.js";

const now = new Date(2026, 10, 2, 10, 30); // 2026-11-02 Monday 10:30
const fmt = (d?: Date) => (d ? `${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}` : "?");

test("parseWhen: various formats", () => {
  assert.equal(fmt(parseWhen("+30m", now)), "11-2 11:00");
  assert.equal(fmt(parseWhen("+2h", now)), "11-2 12:30");
  assert.equal(fmt(parseWhen("+1d", now)), "11-3 10:30");
  assert.equal(fmt(parseWhen("21:00", now)), "11-2 21:00");
  assert.equal(fmt(parseWhen("09:00", now)), "11-3 9:00", "if it has passed, tomorrow");
  assert.equal(fmt(parseWhen("tomorrow 9:30", now)), "11-3 9:30");
  assert.equal(fmt(parseWhen("tomorrow", now)), "11-3 9:00");
  assert.equal(fmt(parseWhen("day after tomorrow 8am", now)), "11-4 8:00");
  assert.equal(fmt(parseWhen("Friday 18:00", now)), "11-6 18:00");
  assert.equal(fmt(parseWhen("Monday 09:00", now)), "11-9 9:00", "today is Monday but it has passed, so next Monday");
  assert.equal(fmt(parseWhen("next Wednesday 10:00", now)), "11-11 10:00");
  assert.equal(fmt(parseWhen("2026-11-05 09:00", now)), "11-5 9:00");
  assert.equal(parseWhen("some other day", now), undefined);
});

test("nextRun: daily, weekdays, weekly, hourly", () => {
  assert.equal(fmt(nextRun("every day 09:00", now)), "11-3 9:00");
  assert.equal(fmt(nextRun("every day 21:00", now)), "11-2 21:00");
  const fri = new Date(2026, 10, 6, 10, 0);
  assert.equal(fmt(nextRun("weekdays 09:00", fri)), "11-9 9:00", "skip the weekend after Friday");
  assert.equal(fmt(nextRun("every Monday 09:00", now)), "11-9 9:00");
  assert.equal(fmt(nextRun("every Wednesday 20:00", now)), "11-4 20:00");
  assert.equal(fmt(nextRun("every hour", now)), "11-2 11:00");
  assert.equal(nextRun("occasionally", now), undefined);
});

test("showTime", () => {
  assert.equal(showTime(new Date(2026, 10, 2, 21, 0).toISOString(), now), "today 21:00");
  assert.equal(showTime(new Date(2026, 10, 3, 9, 5).toISOString(), now), "tomorrow 09:05");
  assert.equal(showTime(new Date(2026, 10, 9, 9, 0).toISOString(), now), "Nov 9 09:00");
});
