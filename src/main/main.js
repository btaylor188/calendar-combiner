const { app, BrowserWindow, WebContentsView, ipcMain, shell, nativeTheme, Menu } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const store = require("./store");
const { AccountSync, anchorFor } = require("./sync");
const { DemoSync, DEMO_ACCOUNTS } = require("./demo");
const { addDays, localToday } = require("./parse");
const { isOutlookUrl, prepareSession, clearSession } = require("./sessions");

const DEMO = process.argv.includes("--demo");
const CAPTURE = process.env.CC_CAPTURE; // write a screenshot of the window here, then quit (for testing)
const RAIL_WIDTH = 72;
const TICK_MS = 15 * 60 * 1000;
const AUTH_HOSTS = /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|login\.live\.com|account\.live\.com|microsoftonline\.com)$/;

if (process.env.CC_THEME) nativeTheme.themeSource = process.env.CC_THEME; // for testing
if (process.env.CC_USER_DATA) app.setPath("userData", process.env.CC_USER_DATA); // for testing
if (DEMO) app.setPath("userData", path.join(app.getPath("temp"), "calendar-combiner-demo"));
if (!app.requestSingleInstanceLock()) app.quit();

let win;
let accounts = [];
let active = "combined";
const syncs = new Map();
const views = new Map();

const baseUrl = (a) => (a.kind === "personal" ? "https://outlook.live.com" : "https://outlook.office.com");
const saveAccounts = () => DEMO || store.write("accounts.json", accounts);
const publicAccounts = () => accounts.map((a) => ({ ...a, status: syncs.get(a.id)?.status }));

let eventsTimer;
function broadcastEvents() {
  clearTimeout(eventsTimer);
  eventsTimer = setTimeout(() => win?.webContents.send("events"), 400);
}
function broadcastAccounts() {
  win?.webContents.send("accounts", publicAccounts());
}

function startSync(account) {
  const sync = DEMO ? new DemoSync(account) : new AccountSync(account);
  sync.on("status", broadcastAccounts);
  sync.on("updated", () => { broadcastAccounts(); broadcastEvents(); });
  syncs.set(account.id, sync);
  return sync;
}

function upcomingAnchors() {
  const today = localToday();
  return [0, 7, 14].map((d) => anchorFor(addDays(today, d)));
}

// --- Account tabs: the real Outlook on the web, one persistent session each ---

function accountView(account) {
  if (views.has(account.id)) return views.get(account.id);
  const partition = `persist:acct-${account.id}`;
  prepareSession(partition);
  const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true } });
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    let host = "";
    try { host = new URL(url).hostname; } catch {}
    if (url === "about:blank" || AUTH_HOSTS.test(host) || isOutlookUrl(url)) return { action: "allow" };
    if (/^https?:/.test(url)) shell.openExternal(url); // Teams links, attachments, etc.
    return { action: "deny" };
  });
  const onNavigate = (_e, url) => { if (isOutlookUrl(url)) syncs.get(account.id)?.resume(); };
  wc.on("did-navigate", onNavigate);
  wc.on("did-navigate-in-page", onNavigate);
  wc.loadURL(`${baseUrl(account)}/calendar/view/week`);
  views.set(account.id, view);
  return view;
}

function layout() {
  if (active === "combined" || !views.has(active)) return;
  const [width, height] = win.getContentSize();
  views.get(active).setBounds({ x: RAIL_WIDTH, y: 0, width: width - RAIL_WIDTH, height });
}

function show(target, date) {
  for (const view of views.values()) win.contentView.removeChildView(view);
  active = target;
  if (target === "combined") return;
  const account = accounts.find((a) => a.id === target);
  if (!account || DEMO) { active = "combined"; return; }
  const view = accountView(account);
  win.contentView.addChildView(view);
  layout();
  if (date) {
    const [y, m, d] = date.split("-").map(Number);
    view.webContents.loadURL(`${baseUrl(account)}/calendar/view/day/${y}/${m}/${d}`);
  }
  view.webContents.focus();
}

// --- IPC ---

ipcMain.handle("accounts:list", () => publicAccounts());

ipcMain.handle("accounts:add", (_e, input) => {
  const account = {
    id: crypto.randomBytes(6).toString("hex"),
    name: String(input.name || "").trim().slice(0, 40) || "Account",
    color: /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : "#1F4E79",
    kind: input.kind === "personal" ? "personal" : "work",
  };
  accounts.push(account);
  saveAccounts();
  startSync(account);
  broadcastAccounts();
  return account;
});

ipcMain.handle("accounts:update", (_e, id, patch) => {
  const account = accounts.find((a) => a.id === id);
  if (!account) return null;
  if (typeof patch.name === "string" && patch.name.trim()) account.name = patch.name.trim().slice(0, 40);
  if (/^#[0-9a-f]{6}$/i.test(patch.color ?? "")) account.color = patch.color;
  saveAccounts();
  broadcastAccounts();
  broadcastEvents();
  return account;
});

ipcMain.handle("accounts:remove", async (_e, id) => {
  if (active === id) show("combined");
  accounts = accounts.filter((a) => a.id !== id);
  saveAccounts();
  syncs.get(id)?.forget();
  syncs.delete(id);
  views.get(id)?.webContents.close();
  views.delete(id);
  if (!DEMO) await clearSession(`persist:acct-${id}`);
  broadcastAccounts();
  broadcastEvents();
});

ipcMain.handle("view:show", (_e, target, date) => show(target, date));
ipcMain.handle("view:reload", (_e, id) => views.get(id)?.webContents.reload());

ipcMain.handle("events:get", (_e, start, end) =>
  [...syncs.values()].flatMap((s) => s.eventsBetween(start.slice(0, 10), end.slice(0, 10))));

ipcMain.handle("events:refresh", (_e, start, end) => {
  for (const s of syncs.values()) s.refresh(start.slice(0, 10), end.slice(0, 10));
});

// --- Window ---

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 520,
    title: "Calendar Combiner",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1E2326" : "#F4F6F3",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), sandbox: true, contextIsolation: true },
  });
  win.on("resize", layout);
  win.on("closed", () => app.quit()); // hidden sync windows shouldn't keep the app alive
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  if (CAPTURE) {
    win.webContents.on("console-message", (e) => console.log(`[renderer] ${e.message}`));
    win.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.CC_CAPTURE_DELAY) || 2500));
      fs.writeFileSync(CAPTURE, (await win.webContents.capturePage()).toPNG());
      app.quit();
    });
  }
}

app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  accounts = DEMO ? DEMO_ACCOUNTS : store.read("accounts.json", []);
  for (const account of accounts) startSync(account);
  createWindow();
  if (!DEMO) {
    const tick = () => { for (const s of syncs.values()) for (const a of upcomingAnchors()) s.request(a); };
    tick();
    setInterval(tick, TICK_MS);
  }
});

app.on("window-all-closed", () => app.quit());
