const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLabel, headerDates } = require("../src/main/parse");

test("timed event, US format", () => {
  const ev = parseLabel("Weekly sync, 10:00 AM to 10:30 AM, Monday, October 13, 2026, Microsoft Teams Meeting, By Jane Doe, Busy, Recurring event");
  assert.deepEqual(ev, {
    title: "Weekly sync", allDay: false, start: "2026-10-13T10:00", end: "2026-10-13T10:30",
    canceled: false, location: "Microsoft Teams Meeting", organizer: "Jane Doe", busy: "busy", recurring: true,
  });
});

test("afternoon and noon handling", () => {
  const ev = parseLabel("Lunch, 12:00 PM to 1:15 PM, Tuesday, October 14, 2026, Free");
  assert.equal(ev.start, "2026-10-14T12:00");
  assert.equal(ev.end, "2026-10-14T13:15");
  assert.equal(ev.busy, "free");
});

test("24-hour, UK date order", () => {
  const ev = parseLabel("Board review, 14:00 to 15:30, Wednesday 15 October 2026, Room 4, Tentative");
  assert.equal(ev.start, "2026-10-15T14:00");
  assert.equal(ev.end, "2026-10-15T15:30");
  assert.equal(ev.location, "Room 4");
  assert.equal(ev.busy, "tentative");
});

test("all-day single and multi-day", () => {
  const one = parseLabel("Holiday, all day event, Friday, October 17, 2026, Away");
  assert.deepEqual([one.allDay, one.start, one.end, one.busy], [true, "2026-10-17", "2026-10-18", "oof"]);
  const multi = parseLabel("Conference, all day event, Monday, October 19, 2026 to Wednesday, October 21, 2026, Busy");
  assert.deepEqual([multi.start, multi.end], ["2026-10-19", "2026-10-22"]);
});

test("multi-day timed event with times before dates", () => {
  const ev = parseLabel("Trip, 9:00 AM Monday, October 19, 2026 to 5:00 PM Tuesday, October 20, 2026, Busy");
  assert.deepEqual([ev.start, ev.end], ["2026-10-19T09:00", "2026-10-20T17:00"]);
});

test("overnight event", () => {
  const ev = parseLabel("Release, 11:00 PM to 1:00 AM, Thursday, October 16, 2026");
  assert.deepEqual([ev.start, ev.end], ["2026-10-16T23:00", "2026-10-17T01:00"]);
});

test("canceled prefix", () => {
  const ev = parseLabel("Canceled: Standup, 9:00 AM to 9:15 AM, Monday, October 13, 2026");
  assert.equal(ev.canceled, true);
  assert.equal(ev.title, "Standup");
});

test("non-event labels are ignored", () => {
  assert.equal(parseLabel("Monday, October 13, 2026"), null);
  assert.equal(parseLabel("New event"), null);
  assert.equal(parseLabel("Go to next week"), null);
  // A selected time slot: time range and date, but no title
  assert.equal(parseLabel("9:00 AM to 9:30 AM, Tuesday, October 14, 2026"), null);
  assert.equal(parseLabel(", 2:00 PM to 2:30 PM, Tuesday, October 14, 2026"), null);
});

test("header dates", () => {
  assert.deepEqual(
    headerDates(["Sunday, October 12, 2026", "Monday, October 13, 2026", "Standup, 9:00 AM to 9:15 AM, Monday, October 13, 2026"]),
    ["2026-10-12", "2026-10-13"]);
});

test("week range in Outlook's toolbar", () => {
  const { weekRangeStart } = require("../src/main/parse");
  assert.equal(weekRangeStart(["October 12–18, 2026"]), "2026-10-12");
  assert.equal(weekRangeStart(["Oct 11 - 17, 2026"]), "2026-10-11");
  assert.equal(weekRangeStart(["September 28 – October 4, 2026"]), "2026-09-28");
  assert.equal(weekRangeStart(["Dec 28, 2026 – Jan 3, 2027"]), "2026-12-28");
  assert.equal(weekRangeStart(["Dec 28 – Jan 3, 2027"]), "2026-12-28");
  assert.equal(weekRangeStart(["12–18 October 2026"]), "2026-10-12");
  assert.equal(weekRangeStart(["28 September – 4 October 2026"]), "2026-09-28");
  // Strings seen in Outlook on the web (Oct 2026)
  assert.equal(weekRangeStart(["October 11–17, 2026, Jump to a specific date or date range."]), "2026-10-11");
  assert.equal(weekRangeStart(["Loaded 7 events in 1 selected calendars October 11–17, 2026."]), "2026-10-11");
  // Work week (Mon–Fri) counts too; a month or a single event time does not
  assert.equal(weekRangeStart(["October 12–16, 2026"]), "2026-10-12");
  assert.equal(weekRangeStart(["October 2026", "9:00 AM - 9:30 AM"]), null);
  assert.equal(weekRangeStart(["October 1–31, 2026"]), null);
});
