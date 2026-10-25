// Keeps one hidden Outlook-on-the-web window per account and reads events from it,
// one week at a time. Event data stays on this machine: in memory and in a local cache file.
const { BrowserWindow } = require("electron");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const store = require("./store");
const { parseLabel, weekRange, addDays, dayDiff, localToday } = require("./parse");
const { isOutlookUrl, prepareSession } = require("./sessions");

const STALE_MS = 15 * 60 * 1000;
const PAGE_TIMEOUT_MS = 35 * 1000;
const MAX_WEEK_MOVES = 60;
const RETRY_MS = 5 * 60 * 1000;

// Runs inside the Outlook page, in an isolated world. Collects event labels, a fingerprint of
// the page text (to notice when the week changes), toolbar lines that may hold the shown week,
// and the names of buttons without digits (navigation, not events).
const PAGE_STATE = `(() => {
  const labels = new Set();
  for (const el of document.querySelectorAll("[aria-label]")) {
    const label = el.getAttribute("aria-label");
    if (label && label.length >= 10 && label.length <= 1000 && /\\d/.test(label)) labels.add(label);
  }
  const text = document.body ? document.body.innerText : "";
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  const looksLikeRange = (t) => t.length >= 8 && t.length <= 80 && /\\d{4}/.test(t) && /[\\u2013\\u2014-]/.test(t)
    && /\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s/i.test(t);
  const rangeTexts = text.split("\\n").map((t) => t.trim()).filter(looksLikeRange);
  const buttons = new Set();
  for (const el of document.querySelectorAll("button, [role=button]")) {
    const name = (el.getAttribute("aria-label") || el.title || "").trim();
    const head = name.split(/\\s*\\n|\\s{2,}/)[0];
    if (looksLikeRange(name)) rangeTexts.push(name);
    if (head && head.length <= 60 && !/\\d/.test(head)) buttons.add(head);
  }
  return { url: location.href, labels: [...labels], hash, rangeTexts: rangeTexts.slice(0, 20), buttons: [...buttons].slice(0, 80) };
})()`;

const NAV_PATTERNS = { next: "\\b(next|forward)\\b", previous: "\\b(previous|prev|back|backward|earlier)\\b" };

// Presses Outlook's own "next week" / "previous week" button. Returns the button's name, or null.
const pressNav = (dir) => `(() => {
  const want = new RegExp(${JSON.stringify(NAV_PATTERNS[dir])}, "i");
  const found = [...document.querySelectorAll("button, [role=button]")]
    // Compare only the start of the name: Outlook appends the target week ("Go to next week \\nOctober 18–24, 2026").
    .map((el) => ({ el, name: (el.getAttribute("aria-label") || el.title || "").trim().split(/\\s*\\n|\\s{2,}/)[0] }))
    .filter((b) => b.name && !/\\d/.test(b.name) && want.test(b.name) && !/month|year/i.test(b.name)
      && !b.el.disabled && b.el.getAttribute("aria-disabled") !== "true");
  const pick = found.find((b) => /week/i.test(b.name)) || found[0];
  if (!pick) return null;
  pick.el.click();
  return pick.name;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wednesday of the Monday-start week containing `day` (YYYY-MM-DD). */
function anchorFor(day) {
  const [y, m, d] = day.split("-").map(Number);
  const mondayOffset = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return addDays(day, 2 - mondayOffset);
}

function daysBetween(start, end) {
  const out = [];
  for (let d = start; d < end; d = addDays(d, 1)) out.push(d);
  return out;
}

class SignInNeeded extends Error {}

class AccountSync extends EventEmitter {
  constructor(account) {
    super();
    this.account = account;
    this.partition = `persist:acct-${account.id}`;
    // v2: earlier versions could store the current week's view under other weeks, so start fresh.
    this.cacheName = `cache/${account.id}.v2.json`;
    store.remove(`cache/${account.id}.json`);
    this.days = new Map(Object.entries(store.read(this.cacheName, {})));
    this.queue = [];
    this.failed = new Map(); // anchor -> time of last failure
    this.busy = false;
    this.win = null;
    this.loadedOn = null; // the date the calendar page was loaded (it opens on that week)
    this.position = null; // anchor of the week the hidden page is showing
    this.status = { state: "idle", message: "", lastSync: store.read(this.cacheName + ".meta", {}).lastSync || null };
    store.remove(`cache/${account.id}.json.meta`);
  }

  get base() {
    if (process.env.CC_OUTLOOK_BASE) return process.env.CC_OUTLOOK_BASE; // tests: a mock Outlook
    return this.account.kind === "personal" ? "https://outlook.live.com" : "https://outlook.office.com";
  }

  setStatus(state, message = "") {
    this.status = { ...this.status, state, message };
    this.emit("status");
  }

  window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    prepareSession(this.partition);
    this.win = new BrowserWindow({
      show: false,
      width: 1500,
      height: 1600,
      paintWhenInitiallyHidden: true,
      webPreferences: { partition: this.partition, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    });
    this.win.webContents.setAudioMuted(true);
    this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.win.webContents.on("did-navigate", () => { this.loadedOn = null; }); // full reload: position unknown
    return this.win;
  }

  /** Queue a week for reading. Urgent weeks jump the line. */
  request(anchor, urgent = false, force = false) {
    if (this.status.state === "signin") return;
    if (anchor === this.current) return;
    if (!force && Date.now() - (this.failed.get(anchor) ?? 0) < RETRY_MS) return;
    const i = this.queue.indexOf(anchor);
    if (i >= 0) {
      if (!urgent) return;
      this.queue.splice(i, 1);
    }
    urgent ? this.queue.unshift(anchor) : this.queue.push(anchor);
    this.pump();
  }

  /** Called once the user has signed in on the account's tab. */
  resume() {
    if (this.status.state !== "signin") return;
    this.setStatus("idle");
    const today = localToday();
    for (let w = 0; w < 3; w++) this.request(anchorFor(addDays(today, w * 7)));
  }

  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length && this.status.state !== "signin") {
        const anchor = this.queue.shift();
        this.current = anchor;
        this.setStatus("syncing");
        try {
          await this.readWeek(anchor);
          this.failed.delete(anchor);
          if (this.status.state === "syncing") this.setStatus("idle");
        } catch (err) {
          if (err instanceof SignInNeeded) {
            this.queue = [];
            this.setStatus("signin", "Sign in on this account's tab to start syncing.");
          } else {
            this.failed.set(anchor, Date.now());
            this.loadedOn = null; // start from a fresh page next time
            this.setStatus("error", err.message);
          }
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async pageState() {
    const win = this.window();
    if (!isOutlookUrl(win.webContents.getURL())) throw new SignInNeeded();
    const state = await win.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: PAGE_STATE }]);
    // Event labels can contain dates with dashes; only toolbar-like text counts as the shown week.
    state.range = weekRange(state.rangeTexts.filter((t) => !parseLabel(t) && !/\b(next|previous|prev)\b/i.test(t)));
    return state;
  }

  /** Wait until the page stops changing. */
  async settle(maxMs = 12000) {
    const started = Date.now();
    let last = null;
    let steady = 0;
    let state;
    while (Date.now() - started < maxMs) {
      await sleep(700);
      state = await this.pageState();
      const signature = `${state.hash}|${state.labels.length}`;
      steady = signature === last ? steady + 1 : 0;
      last = signature;
      if (steady >= 2) break;
    }
    return state;
  }

  /** Load the calendar if needed. It opens on today's week. */
  async ensureCalendar() {
    const win = this.window();
    const today = localToday();
    if (this.loadedOn === today && isOutlookUrl(win.webContents.getURL())) return;
    // Outlook is a single-page app and sometimes aborts the initial navigation; that's fine.
    await win.loadURL(`${this.base}/calendar/view/week`).catch(() => {});
    const started = Date.now();
    while (Date.now() - started < PAGE_TIMEOUT_MS) {
      await sleep(1500);
      const state = await this.pageState();
      const hasNav = state.buttons.some((b) => new RegExp(NAV_PATTERNS.next, "i").test(b));
      if (hasNav || state.range) {
        this.loadedOn = today;
        this.position = anchorFor(today);
        return;
      }
    }
    const state = await this.pageState();
    this.writeDiagnostics("load", null, state);
    throw new Error("Couldn't find the calendar on the Outlook page. It may have changed layout.");
  }

  /** Page structure for troubleshooting. Event labels are kept only for reads, where they explain the result. */
  writeDiagnostics(stage, anchor, state, parsed) {
    const { labels, ...structure } = state;
    store.write(`diagnostics/${this.account.id}.json`, {
      stage, anchor, at: new Date().toISOString(), ...structure, ...(parsed ? { labels, parsed } : {}),
    });
  }

  /** Move the hidden page to the week of `anchor`, using Outlook's own buttons. */
  async goToWeek(anchor) {
    let state = await this.settle();
    for (let moves = 0; ; moves++) {
      // Trust the toolbar when it says which week is showing; otherwise count button presses.
      if (state.range) this.position = anchorFor(addDays(state.range.start, 1));
      const weeks = Math.round(dayDiff(this.position, anchor) / 7);
      if (weeks === 0) return state;
      if (moves >= MAX_WEEK_MOVES) throw new Error(`Couldn't move Outlook to the week of ${anchor}.`);
      const dir = weeks > 0 ? "next" : "previous";
      const pressed = await this.window().webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: pressNav(dir) }]);
      if (!pressed) {
        this.writeDiagnostics("navigate", anchor, state);
        throw new Error(`Couldn't find Outlook's ${dir} week button.`);
      }
      this.position = addDays(this.position, weeks > 0 ? 7 : -7);
      const before = state.hash;
      const started = Date.now();
      do {
        await sleep(400);
        state = await this.pageState();
      } while (state.hash === before && Date.now() - started < 8000);
      if (state.hash === before) throw new Error("Outlook didn't move to another week.");
      state = await this.settle();
    }
  }

  async readWeek(anchor) {
    await this.ensureCalendar();
    const state = await this.goToWeek(anchor);
    const events = state.labels.map(parseLabel).filter(Boolean);
    this.writeDiagnostics("read", anchor, { ...state, verified: Boolean(state.range) }, events);

    // Which days did the page show? Prefer the toolbar's range; otherwise rely on Monday–Saturday,
    // which every week layout includes whether the week starts on Sunday or Monday.
    const covered = state.range
      ? daysBetween(state.range.start, addDays(state.range.end, 1))
      : daysBetween(addDays(anchor, -2), addDays(anchor, 4));

    const now = Date.now();
    const byDay = new Map(covered.map((day) => [day, []]));
    for (const ev of events) {
      const day = ev.start.slice(0, 10);
      const item = { ...ev, id: this.eventId(ev), accountId: this.account.id };
      if (byDay.has(day)) byDay.get(day).push(item);
      else {
        // Started outside the visible week (e.g. a multi-day event): merge, don't replace.
        const entry = this.days.get(day) ?? { events: [], fetchedAt: 0 };
        entry.events = [...entry.events.filter((e) => e.id !== item.id), item];
        this.days.set(day, entry);
      }
    }
    for (const [day, list] of byDay) this.days.set(day, { events: list, fetchedAt: now });

    this.status.lastSync = new Date(now).toISOString();
    store.write(this.cacheName, Object.fromEntries(this.days));
    store.write(this.cacheName + ".meta", { lastSync: this.status.lastSync });
    this.emit("updated");
  }

  eventId(ev) {
    return crypto.createHash("sha1").update(`${this.account.id}|${ev.title}|${ev.start}|${ev.end}`).digest("hex").slice(0, 16);
  }

  /** Cached events overlapping [start, end); queues any weeks that are missing or stale. */
  eventsBetween(start, end) {
    const out = new Map();
    const scanFrom = addDays(start, -14); // multi-day events that began earlier
    for (const [day, entry] of this.days) {
      if (day < scanFrom || day >= end) continue;
      for (const ev of entry.events) if (ev.end > start) out.set(ev.id, ev);
    }
    const anchors = new Set(daysBetween(start, end).map(anchorFor));
    for (const anchor of anchors) {
      const weekDays = daysBetween(addDays(anchor, -2), addDays(anchor, 4)).map((d) => this.days.get(d));
      const missing = weekDays.some((e) => !e || !e.fetchedAt);
      const stale = weekDays.some((e) => e && Date.now() - e.fetchedAt > STALE_MS);
      if (missing) this.request(anchor, true);
      else if (stale) this.request(anchor);
    }
    return [...out.values()];
  }

  refresh(start, end) {
    if (this.status.state === "error") this.setStatus("idle");
    for (const anchor of new Set(daysBetween(start, end).map(anchorFor))) this.request(anchor, true, true);
  }

  destroy() {
    this.queue = [];
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.removeAllListeners();
  }

  forget() {
    this.destroy();
    store.remove(this.cacheName);
    store.remove(this.cacheName + ".meta");
    store.remove(`diagnostics/${this.account.id}.json`);
  }
}

module.exports = { AccountSync, anchorFor };
