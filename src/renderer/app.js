const INKS = ["#1F4E79", "#7A2E3A", "#4F6B2F", "#A8741A", "#4B4F8C", "#2F6B66"];
const BUSY_LABELS = { busy: "Busy", free: "Free", tentative: "Tentative", oof: "Away", elsewhere: "Working elsewhere" };

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
};
const setInk = (node, color) => { node.style.setProperty("--ink", color); return node; };

const prefs = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

let accounts = [];
let active = "combined";
let hidden = new Set(prefs.get("hidden", []));
let overlapPairs = new Map(); // event id -> [other events]
const accountsReady = window.cc.listAccounts().then(renderAccounts);

function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] || "?").slice(0, 2).toUpperCase();
}
const accountById = (id) => accounts.find((a) => a.id === id);

// ---------- Rail ----------

function setActive(target, date) {
  active = target;
  $("rail-combined").classList.toggle("active", target === "combined");
  for (const btn of $("rail-accounts").children) btn.classList.toggle("active", btn.dataset.id === target);
  window.cc.show(target, date);
}

function renderRail() {
  $("quad").replaceChildren(...[0, 1, 2, 3].map((i) => {
    const sq = el("i");
    if (accounts[i]) sq.style.background = accounts[i].color;
    return sq;
  }));
  $("rail-accounts").replaceChildren(...accounts.map((a) => {
    const state = a.status?.state ?? "idle";
    const hint = { signin: " (needs sign-in)", error: " (sync problem)", syncing: " (syncing)" }[state] ?? "";
    const btn = el("button", {
      type: "button",
      className: "rail-btn acct" + (active === a.id ? " active" : ""),
      title: a.name + hint,
      ariaLabel: a.name + hint,
    }, initials(a.name), el("span", { className: "dot" }));
    btn.dataset.id = a.id;
    btn.dataset.state = state;
    setInk(btn, a.color);
    btn.onclick = () => setActive(a.id);
    return btn;
  }));
}

// ---------- Combined header, legend, notices ----------

function renderLegend() {
  $("legend").replaceChildren(...accounts.map((a) => {
    const box = setInk(el("input", { type: "checkbox", checked: !hidden.has(a.id) }), a.color);
    box.onchange = () => {
      box.checked ? hidden.delete(a.id) : hidden.add(a.id);
      prefs.set("hidden", [...hidden]);
      calendar.refetchEvents();
    };
    return el("label", {}, box, el("span", { textContent: a.name }));
  }));
}

function renderNotice() {
  const notice = $("notice");
  const signin = accounts.find((a) => a.status?.state === "signin");
  const failing = accounts.find((a) => a.status?.state === "error");
  if (signin) {
    const btn = el("button", { type: "button", textContent: `Sign in to ${signin.name}` });
    btn.onclick = () => setActive(signin.id);
    notice.replaceChildren(el("span", { textContent: `${signin.name} isn't signed in, so its meetings are missing.` }), btn);
  } else if (failing) {
    const btn = el("button", { type: "button", textContent: "Try again" });
    btn.onclick = refreshView;
    notice.replaceChildren(el("span", { textContent: `Couldn't read ${failing.name}'s calendar. ${failing.status.message}` }), btn);
  }
  notice.hidden = !(signin || failing);
}

function minutesAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

function renderSyncLine() {
  const syncing = accounts.filter((a) => a.status?.state === "syncing").map((a) => a.name);
  const synced = accounts.map((a) => a.status?.lastSync).filter(Boolean).sort();
  let text = "";
  if (syncing.length) text = `Reading ${syncing.join(" and ")}…`;
  else if (synced.length) text = `Oldest update ${minutesAgo(synced[0])}`;
  $("sync-line").textContent = text;
  $("refresh").classList.toggle("busy", syncing.length > 0);
}

/** Re-read the weeks on screen from every account, skipping the 15-minute freshness window. */
function refreshView() {
  window.cc.refresh(calendar.view.activeStart.toISOString(), calendar.view.activeEnd.toISOString());
}

function renderEmpty() {
  const empty = accounts.length === 0;
  $("empty").hidden = !empty;
  $("calendar").hidden = empty;
  $("bar").hidden = empty;
}

function renderAccounts(list) {
  accounts = list;
  renderRail();
  renderLegend();
  renderNotice();
  renderSyncLine();
  renderEmpty();
  if ($("accounts-dialog").open) renderAccountRows();
}

function renderTitle(view) {
  const start = view.currentStart;
  const end = new Date(view.currentEnd - 1);
  const year = el("span", { textContent: ` ${start.getFullYear()}` });
  const fmt = (d, o) => d.toLocaleDateString([], o);
  let main;
  if (view.type === "dayGridMonth") main = fmt(start, { month: "long" });
  else if (view.type === "timeGridDay") main = fmt(start, { weekday: "long", month: "short", day: "numeric" });
  else if (start.getMonth() === end.getMonth()) main = `${fmt(start, { month: "short", day: "numeric" })} – ${end.getDate()}`;
  else main = `${fmt(start, { month: "short", day: "numeric" })} – ${fmt(end, { month: "short", day: "numeric" })}`;
  $("range-title").replaceChildren(main, year);
  for (const btn of document.querySelectorAll(".views button")) {
    btn.setAttribute("aria-selected", String(btn.dataset.view === view.type));
  }
}

// ---------- Double-bookings ----------

function findOverlaps(events) {
  const pairs = new Map();
  const timed = events
    .filter((e) => !e.allDay && !e.canceled && e.busy !== "free")
    .sort((a, b) => a.start.localeCompare(b.start));
  let count = 0;
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j++) {
      const [a, b] = [timed[i], timed[j]];
      if (a.accountId === b.accountId) continue;
      count++;
      pairs.set(a.id, [...(pairs.get(a.id) ?? []), b]);
      pairs.set(b.id, [...(pairs.get(b.id) ?? []), a]);
    }
  }
  return { pairs, count };
}

function renderOverlaps(count) {
  const node = $("overlaps");
  node.hidden = count === 0;
  node.textContent = count === 1 ? "1 double-booking" : `${count} double-bookings`;
}

// ---------- Calendar ----------

async function loadEvents(info, success, failure) {
  try {
    await accountsReady; // FullCalendar fetches as soon as it's constructed
    const raw = await window.cc.getEvents(info.startStr, info.endStr);
    const visible = raw.filter((e) => !hidden.has(e.accountId) && accountById(e.accountId));
    const { pairs, count } = findOverlaps(visible);
    overlapPairs = pairs;
    renderOverlaps(count);
    success(visible.map((e) => ({
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      classNames: ["ev", e.busy, e.canceled && "canceled", pairs.has(e.id) && "overlap"].filter(Boolean),
      extendedProps: e,
    })));
  } catch (err) {
    console.error("Loading events failed:", err);
    failure(err);
  }
}

function eventContent(arg) {
  const e = arg.event.extendedProps;
  const account = accountById(e.accountId);
  const tag = el("span", { className: "ev-tag", textContent: initials(account?.name ?? "") + " " });
  if (arg.view.type.startsWith("list")) {
    return { domNodes: [el("span", {}, tag, arg.event.title)] };
  }
  const sub = [arg.timeText, e.location].filter(Boolean).join(", ");
  return {
    domNodes: [el("div", { className: "ev-inner" },
      el("span", { className: "ev-title" }, tag, arg.event.title),
      arg.event.allDay ? null : el("span", { className: "ev-sub", textContent: sub }))],
  };
}

function whenText(ev) {
  const start = ev.start;
  const end = ev.end;
  const day = { weekday: "long", month: "long", day: "numeric" };
  const time = { hour: "numeric", minute: "2-digit" };
  if (ev.allDay) {
    const last = end ? new Date(end - 86400000) : start;
    const first = start.toLocaleDateString([], day);
    return last > start ? `${first} – ${last.toLocaleDateString([], day)}, all day` : `${first}, all day`;
  }
  const sameDay = end && end.toDateString() === start.toDateString();
  if (!end) return `${start.toLocaleDateString([], day)}, ${start.toLocaleTimeString([], time)}`;
  return sameDay
    ? `${start.toLocaleDateString([], day)}, ${start.toLocaleTimeString([], time)} – ${end.toLocaleTimeString([], time)}`
    : `${start.toLocaleString([], { ...day, ...time })} – ${end.toLocaleString([], { ...day, ...time })}`;
}

function showEvent(info) {
  const ev = info.event;
  const e = ev.extendedProps;
  const account = accountById(e.accountId);
  const dialog = $("event-dialog");
  setInk(dialog, account.color);
  $("ev-account").textContent = account.name;
  $("ev-title").textContent = (e.canceled ? "Canceled: " : "") + ev.title;
  $("ev-when").textContent = whenText(ev);

  const rows = [
    ["Where", e.location],
    ["Organizer", e.organizer],
    ["Shows as", BUSY_LABELS[e.busy]],
    ["Repeats", e.recurring ? "Yes" : ""],
  ].filter(([, v]) => v);
  $("ev-meta").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));

  const others = overlapPairs.get(e.id) ?? [];
  $("ev-overlap").hidden = others.length === 0;
  $("ev-overlap").textContent = "Overlaps with " + others
    .map((o) => `“${o.title}” (${accountById(o.accountId)?.name})`).join(", ");

  const open = $("ev-open");
  open.textContent = `Open in ${account.name}`;
  open.onclick = () => {
    dialog.close();
    setActive(account.id, e.start.slice(0, 10));
  };
  dialog.showModal();
}

const initialView = prefs.get("view", "timeGridWeek");
const calendar = new FullCalendar.Calendar($("calendar"), {
  initialView,
  headerToolbar: false,
  height: "100%",
  nowIndicator: true,
  navLinks: true,
  dayMaxEvents: true,
  scrollTime: "07:30:00",
  slotDuration: "00:30:00",
  eventTimeFormat: { hour: "numeric", minute: "2-digit", meridiem: "short" },
  slotLabelFormat: { hour: "numeric", meridiem: "short" },
  dayHeaderFormat: { weekday: "short", day: "numeric" },
  events: loadEvents,
  eventContent,
  eventClick: showEvent,
  eventDidMount: (arg) => {
    const account = accountById(arg.event.extendedProps.accountId);
    if (account) setInk(arg.el, account.color);
    arg.el.title = `${account?.name}: ${arg.event.title}`;
  },
  datesSet: (arg) => {
    renderTitle(arg.view);
    prefs.set("view", arg.view.type);
  },
});

// ---------- Accounts: add / manage ----------

function openAdd() {
  setActive("combined");
  const used = new Set(accounts.map((a) => a.color.toUpperCase()));
  const first = INKS.find((c) => !used.has(c)) ?? INKS[0];
  $("add-swatches").replaceChildren(...INKS.map((color) => setInk(el("label", { title: color },
    el("input", { type: "radio", name: "color", value: color, checked: color === first, ariaLabel: color }),
    el("span")), color)));
  $("add-form").reset();
  $("add-swatches").querySelector(`input[value="${first}"]`).checked = true;
  $("add-dialog").showModal();
}

$("add-form").onsubmit = async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const account = await window.cc.addAccount(data);
  $("add-dialog").close();
  setActive(account.id);
};
$("add-cancel").onclick = () => $("add-dialog").close();

function statusText(a) {
  const s = a.status ?? {};
  if (s.state === "signin") return "Needs sign-in. Open its tab to sign in.";
  if (s.state === "error") return s.message;
  if (s.state === "syncing") return "Reading calendar…";
  return s.lastSync ? `Updated ${minutesAgo(s.lastSync)}` : "Not read yet";
}

function renderAccountRows() {
  const rows = accounts.map((a) => {
    const color = el("input", { type: "color", value: a.color, ariaLabel: `Color for ${a.name}` });
    color.onchange = () => window.cc.updateAccount(a.id, { color: color.value });
    const pick = setInk(el("span", { className: "ink-pick" }, color), a.color);

    const name = el("input", { type: "text", value: a.name, maxLength: 40, ariaLabel: "Account name" });
    name.onchange = () => window.cc.updateAccount(a.id, { name: name.value });

    const remove = el("button", { type: "button", textContent: "Remove" });
    remove.onclick = () => {
      if (!remove.classList.contains("danger")) {
        remove.classList.add("danger");
        remove.textContent = "Remove and sign out";
        return;
      }
      window.cc.removeAccount(a.id);
    };

    const kind = a.kind === "personal" ? "Outlook.com" : "Microsoft 365";
    return el("li", {}, pick, name, remove, el("span", { className: "sub", textContent: `${kind}. ${statusText(a)}` }));
  });
  $("account-rows").replaceChildren(...(rows.length ? rows : [el("li", { className: "empty", textContent: "No accounts yet." })]));
}

function openManage() {
  setActive("combined");
  renderAccountRows();
  $("accounts-dialog").showModal();
}

// ---------- Wiring ----------

$("rail-combined").onclick = () => setActive("combined");
$("rail-add").onclick = openAdd;
$("empty-add").onclick = openAdd;
$("rail-manage").onclick = openManage;
$("prev").onclick = () => calendar.prev();
$("next").onclick = () => calendar.next();
$("today").onclick = () => calendar.today();
$("refresh").onclick = refreshView;
for (const btn of document.querySelectorAll(".views button")) btn.onclick = () => calendar.changeView(btn.dataset.view);

document.addEventListener("keydown", (e) => {
  if (active !== "combined" || document.querySelector("dialog[open]") || e.target.matches("input")) return;
  if (e.key === "ArrowLeft") calendar.prev();
  else if (e.key === "ArrowRight") calendar.next();
  else if (e.key === "t") calendar.today();
  else if (e.key === "r") refreshView();
});

window.cc.onAccounts(renderAccounts);
window.cc.onEvents(() => calendar.refetchEvents());
setInterval(renderSyncLine, 60 * 1000);

Promise.all([accountsReady, document.fonts.ready]).then(() => calendar.render());
