// How schedules are written: both agents and users use natural-language phrases, and Kiki converts them to local time.
// One-off (when): "+30m" "+2h" "+1d", "09:00" (today, or tomorrow if already past), "tomorrow 09:00", "day after tomorrow 9:30",
//              "Monday 09:00", "2026-11-05 09:00", or an ISO time.
// Repeating (repeat): "every day 09:00", "weekdays 09:00", "every Monday 09:00", "every hour". Stored as-is in the task file so it's readable when opened.

const WEEK: Record<string, number> = { Sun: 0, Sunday: 0, Mon: 1, Monday: 1, Tue: 2, Tuesday: 2, Wed: 3, Wednesday: 3, Thu: 4, Thursday: 4, Fri: 5, Friday: 5, Sat: 6, Saturday: 6 };

function hm(s: string | undefined): [number, number] | undefined {
  if (!s) return [9, 0]; // only "tomorrow" with no time given means 9 AM
  const m = s.trim().match(/^(\d{1,2})(?:[:.](\d{1,2})?)?\s*(?:am|pm)?$/i);
  if (!m) return undefined;
  const h = Number(m[1]), min = Number(m[2] ?? 0);
  return h < 24 && min < 60 ? [h, min] : undefined;
}

function at(base: Date, dayOffset: number, [h, m]: [number, number]): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
}

/** One-off time → Date; returns undefined if it can't be understood. */
export function parseWhen(input: string, now = new Date()): Date | undefined {
  const s = input.trim();
  let m = s.match(/^\+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() + n * ms);
  }
  m = s.match(/^(today|tomorrow|day after tomorrow)\s*(.*)$/i);
  if (m) {
    const t = hm(m[2] || undefined);
    return t && at(now, { today: 0, tomorrow: 1, "day after tomorrow": 2 }[m[1].toLowerCase() as "today"], t);
  }
  m = s.match(/^(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\s*(.*)$/i);
  if (m) {
    const t = hm(m[1] || undefined);
    if (!t) return undefined;
    const dayName = s.match(/^(?:next\s+)?(mon|tue|wed|thu|fri|sat|sun)/i)![1].toLowerCase();
    const dayIndex = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 }[dayName as "mon"];
    if (s.toLowerCase().startsWith("next")) {
      // "next Wednesday": the day in the following week (counting from Monday)
      const toMonday = (1 - now.getDay() + 7) % 7 || 7;
      return at(now, toMonday + ((dayIndex + 6) % 7), t);
    }
    const diff = (dayIndex - now.getDay() + 7) % 7;
    const d = at(now, diff, t);
    return d <= now ? at(now, diff + 7, t) : d;
  }
  const t = hm(s);
  if (t && /^\d/.test(s)) {
    const d = at(now, 0, t);
    return d <= now ? at(now, 1, t) : d;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}:\d{2}))?$/);
  if (m) {
    const [hh, mm] = hm(m[4]) ?? [9, 0];
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The next occurrence of a repeat rule after `after`; returns undefined if the rule can't be understood. */
export function nextRun(repeat: string, after = new Date()): Date | undefined {
  const s = repeat.trim();
  if (/^every\s+hour$/i.test(s)) {
    const d = new Date(after);
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }
  let m = s.match(/^(every day|daily|weekdays?)\s*(.*)$/i);
  if (m) {
    const t = hm(m[2] || undefined);
    if (!t) return undefined;
    for (let i = 0; i < 8; i++) {
      const d = at(after, i, t);
      if (d <= after) continue;
      if (/^weekdays?$/i.test(m[1]) && (d.getDay() === 0 || d.getDay() === 6)) continue;
      return d;
    }
  }
  m = s.match(/^every\s+(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\s*(.*)$/i);
  if (m) {
    const t = hm(m[2] || undefined);
    if (!t) return undefined;
    const dayIndex = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 }[m[1].toLowerCase() as "mon"];
    for (let i = 0; i < 8; i++) {
      const d = at(after, i, t);
      if (d > after && d.getDay() === dayIndex) return d;
    }
  }
  return undefined;
}

/** Human-readable time: "today 09:00", "tomorrow 21:30", "Nov 5 09:00". */
export function showTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  if (diff === 0) return `today ${t}`;
  if (diff === 1) return `tomorrow ${t}`;
  if (diff === 2) return `day after tomorrow ${t}`;
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()} ${t}`;
}
