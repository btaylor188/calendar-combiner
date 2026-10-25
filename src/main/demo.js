// Fake accounts and events for `--demo`, so the UI can be tried without signing in.
const { EventEmitter } = require("node:events");
const { addDays } = require("./parse");

const DEMO_ACCOUNTS = [
  { id: "demo-a", name: "Northwind", initials: "NW", color: "#1F4E79", kind: "work" },
  { id: "demo-b", name: "Contoso", initials: "CO", color: "#7A2E3A", kind: "work" },
  { id: "demo-c", name: "Fabrikam", initials: "FA", color: "#4F6B2F", kind: "work" },
  { id: "demo-d", name: "Tailspin", initials: "TS", color: "#A8741A", kind: "work" },
];

const PATTERNS = {
  "demo-a": [[1, "09:00", "09:30", "Northwind standup"], [3, "09:00", "09:30", "Northwind standup"], [2, "13:00", "14:30", "Data platform review"], [4, "15:00", "16:00", "Quarterly planning"]],
  "demo-b": [[1, "09:15", "10:00", "Contoso weekly sync"], [2, "11:00", "12:00", "Security architecture"], [4, "10:00", "11:30", "Migration workshop"], [5, "14:00", "15:00", "Steering committee"]],
  "demo-c": [[2, "13:30", "14:00", "Fabrikam check-in"], [3, "16:00", "17:00", "Vendor demo"], [5, "09:00", "10:00", "Sprint review"]],
  "demo-d": [[1, "12:00", "13:00", "Lunch with Priya"], [3, "10:30", "11:15", "Tailspin intake call"], [5, "16:30", "17:30", "Contract review"]],
};

class DemoSync extends EventEmitter {
  constructor(account) {
    super();
    this.account = account;
    this.status = { state: "idle", message: "", lastSync: new Date().toISOString() };
  }

  eventsBetween(start, end) {
    const out = [];
    for (let day = start; day < end; day = addDays(day, 1)) {
      const dow = new Date(`${day}T12:00`).getDay();
      for (const [d, from, to, title] of PATTERNS[this.account.id] ?? []) {
        if (d !== dow) continue;
        out.push({ id: `${this.account.id}-${day}-${from}`, accountId: this.account.id, title,
          start: `${day}T${from}`, end: `${day}T${to}`, allDay: false, location: "Microsoft Teams Meeting",
          organizer: "", busy: "busy", recurring: true, canceled: false });
      }
      if (this.account.id === "demo-c" && dow === 5) {
        out.push({ id: `ooo-${day}`, accountId: this.account.id, title: "Out of office", start: day,
          end: addDays(day, 1), allDay: true, location: "", organizer: "", busy: "oof", recurring: false, canceled: false });
      }
    }
    return out;
  }

  request() {}
  resume() {}
  refresh() {}
  destroy() { this.removeAllListeners(); }
  forget() { this.destroy(); }
}

module.exports = { DEMO_ACCOUNTS, DemoSync };
