// Drives the real AccountSync against test/mock/index.html. Run with Electron:
//   CC_OUTLOOK_BASE=http://127.0.0.1:8777 electron test/mock/run.js [--no-range]
const { app } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "cc-mock-")));
app.whenReady().then(async () => {
  const { AccountSync, anchorFor } = require("../../src/main/sync");
  const { addDays, localToday } = require("../../src/main/parse");
  const sync = new AccountSync({ id: "mock", name: "Mock", kind: "work", color: "#1F4E79" });
  const today = localToday();
  const targets = [-3, 5, -1, 0, 9].map((w) => anchorFor(addDays(today, w * 7)));
  let failures = 0;
  for (const anchor of targets) {
    sync.queue = [anchor];
    await sync.pump();
    const day = sync.days.get(anchor);
    const titles = (day?.events ?? []).map((e) => e.title);
    // The mock's event sits on the Wednesday of each Sunday-start week; our anchor is Wednesday too.
    const ok = sync.status.state !== "error" && titles.includes(`Mock meeting ${anchor}`);
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"} week of ${anchor}: ${JSON.stringify(titles)} ${sync.status.message}`);
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  app.exit(failures ? 1 : 0);
});
