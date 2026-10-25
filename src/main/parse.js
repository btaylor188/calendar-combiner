// Turns the accessibility labels Outlook on the web puts on calendar events into
// structured events. Labels look like:
//   "Weekly sync, 10:00 AM to 10:30 AM, Monday, October 13, 2026, Teams Meeting, By Jane Doe, Busy, Recurring event"
//   "Holiday, all day event, Friday, October 17, 2026, Free"
// Times are wall-clock times in the mailbox's time zone, which we treat as local time.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];
const MONTH_RE = MONTHS.map((m) => m.slice(0, 3) + `(?:${m.slice(3)})?`).join("|");
const WEEKDAY_RE = "(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\\s+";

// "Monday, October 13, 2026" / "Oct 13, 2026" / "Monday 13 October 2026" / "13 Oct 2026"
const DATE_RE = new RegExp(
  `(?:${WEEKDAY_RE})?(?:(${MONTH_RE})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})|(\\d{1,2})\\s+(${MONTH_RE})\\.?,?\\s+(\\d{4}))`,
  "gi");
// "10:00 AM", "10:00 a.m.", "14:30"
const TIME_RE = /\b(\d{1,2}):(\d{2})(?:\s*([ap])\.?\s*m\.?)?(?![\d:])/gi;
const ALL_DAY_RE = /\ball[\s-]day\b/i;

const BUSY_WORDS = new Map([
  ["busy", "busy"], ["free", "free"], ["tentative", "tentative"], ["away", "oof"],
  ["out of office", "oof"], ["working elsewhere", "elsewhere"],
]);

function monthIndex(name) {
  const short = name.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(short));
}

function findDates(label) {
  const out = [];
  for (const m of label.matchAll(DATE_RE)) {
    const [month, day, year] = m[1]
      ? [monthIndex(m[1]), +m[2], +m[3]]
      : [monthIndex(m[5]), +m[4], +m[6]];
    if (month < 0 || day < 1 || day > 31) continue;
    out.push({ index: m.index, end: m.index + m[0].length, year, month, day });
  }
  return out;
}

function findTimes(label) {
  const out = [];
  for (const m of label.matchAll(TIME_RE)) {
    let hour = +m[1];
    const minute = +m[2];
    const meridiem = m[3]?.toLowerCase();
    if (meridiem === "p" && hour < 12) hour += 12;
    if (meridiem === "a" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) continue;
    out.push({ index: m.index, end: m.index + m[0].length, hour, minute });
  }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.year}-${pad(d.month + 1)}-${pad(d.day)}`;

function addDays(key, days) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function details(rest) {
  const out = { location: "", organizer: "", busy: "", recurring: false };
  for (const raw of rest.split(/,\s*/)) {
    const part = raw.trim();
    if (!part) continue;
    const lower = part.toLowerCase();
    if (BUSY_WORDS.has(lower)) out.busy = BUSY_WORDS.get(lower);
    else if (/^(?:organi[sz]ed\s+)?by\s+/i.test(part)) out.organizer = part.replace(/^(?:organi[sz]ed\s+)?by\s+/i, "");
    else if (/recurring|series|occurrence/i.test(part)) out.recurring = true;
    else if (/^(?:has attachments?|reminder|private|meeting|event|exception)/i.test(part)) continue;
    else if (!out.location) out.location = part;
  }
  return out;
}

/** Returns an event object, or null when the label isn't a calendar event. */
function parseLabel(label) {
  const text = label.replace(/\s+/g, " ").trim();
  const dates = findDates(text);
  if (dates.length === 0) return null;
  const allDay = ALL_DAY_RE.test(text);
  const times = allDay ? [] : findTimes(text);
  if (!allDay && times.length < 2) return null;

  const firstMarker = Math.min(
    dates[0].index,
    allDay ? text.search(ALL_DAY_RE) : times[0].index);
  let title = text.slice(0, firstMarker).replace(/[,\s]+$/, "").replace(/^(?:event|meeting)\s+/i, "");
  const canceled = /^cancel(?:l)?ed:\s*/i.test(title);
  title = title.replace(/^cancel(?:l)?ed:\s*/i, "");
  // Selected time slots carry a label that starts straight at the time, with no title.
  if (!title) return null;

  const lastDate = dates[dates.length - 1];
  const extra = details(text.slice(lastDate.end));

  const startDay = dateKey(dates[0]);
  const endDay = dates.length > 1 ? dateKey(lastDate) : startDay;

  if (allDay) {
    return { title, allDay: true, start: startDay, end: addDays(endDay, 1), canceled, ...extra };
  }

  // Times may appear before or after the dates ("9:00 AM Monday, ... to 5:00 PM Tuesday, ...").
  const [t1, t2] = times;
  const hhmm = (t) => `${pad(t.hour)}:${pad(t.minute)}`;
  let end = `${endDay}T${hhmm(t2)}`;
  const start = `${startDay}T${hhmm(t1)}`;
  if (end <= start) end = `${addDays(endDay, 1)}T${hhmm(t2)}`; // runs past midnight
  return { title, allDay: false, start, end, canceled, ...extra };
}

/** Dates that look like day column headers: short labels that are just a date. */
function headerDates(labels) {
  const out = new Set();
  for (const label of labels) {
    if (label.length > 60 || findTimes(label).length) continue;
    const dates = findDates(label);
    if (dates.length === 1) out.add(dateKey(dates[0]));
  }
  return [...out].sort();
}

function dayDiff(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

const DASH = "\\s*[\u2013\u2014-]\\s*";
const M = `(${MONTH_RE})\\.?`;
const RANGE_PATTERNS = [
  // Sep 28 – Oct 4, 2026 / Dec 28, 2026 – Jan 3, 2027
  [new RegExp(`${M}\\s+(\\d{1,2}),?(?:\\s+(\\d{4}))?${DASH}${M}\\s+(\\d{1,2}),?\\s+(\\d{4})`, "i"),
    (m) => [m[1], m[2], m[3], m[4], m[5], m[6]]],
  // October 12 – 18, 2026
  [new RegExp(`${M}\\s+(\\d{1,2})${DASH}(\\d{1,2}),?\\s+(\\d{4})`, "i"),
    (m) => [m[1], m[2], m[4], m[1], m[3], m[4]]],
  // 28 September – 4 October 2026 / 28 Dec 2026 – 3 Jan 2027
  [new RegExp(`(\\d{1,2})\\s+${M}(?:\\s+(\\d{4}))?${DASH}(\\d{1,2})\\s+${M},?\\s+(\\d{4})`, "i"),
    (m) => [m[2], m[1], m[3], m[5], m[4], m[6]]],
  // 12 – 18 October 2026
  [new RegExp(`(\\d{1,2})${DASH}(\\d{1,2})\\s+${M},?\\s+(\\d{4})`, "i"),
    (m) => [m[3], m[1], m[4], m[3], m[2], m[4]]],
];

/**
 * The week Outlook is showing, read from its toolbar text ("October 12–18, 2026").
 * Returns { start, end } (inclusive, YYYY-MM-DD), or null if no week range is found.
 */
function weekRange(texts) {
  for (const text of texts) {
    for (const [re, pick] of RANGE_PATTERNS) {
      const m = text.match(re);
      if (!m) continue;
      const [m1, d1, y1, m2, d2, y2] = pick(m);
      const endYear = +y2;
      const startMonth = monthIndex(m1);
      const endMonth = monthIndex(m2);
      const startYear = y1 ? +y1 : startMonth > endMonth ? endYear - 1 : endYear;
      const start = dateKey({ year: startYear, month: startMonth, day: +d1 });
      const end = dateKey({ year: endYear, month: endMonth, day: +d2 });
      const span = dayDiff(start, end);
      if (span >= 4 && span <= 6) return { start, end }; // a week or work week
    }
  }
  return null;
}

const weekRangeStart = (texts) => weekRange(texts)?.start ?? null;

/** Today's date on this computer, as YYYY-MM-DD. */
function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

module.exports = { parseLabel, headerDates, weekRange, weekRangeStart, addDays, dayDiff, localToday };
