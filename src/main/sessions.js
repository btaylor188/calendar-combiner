// Per-account browser sessions. Each account gets its own persistent cookie jar
// so the four sign-ins never interfere with each other.
const path = require("node:path");
const { app, session } = require("electron");

const OUTLOOK_HOSTS = ["outlook.office.com", "outlook.office365.com", "outlook.live.com", "outlook.cloud.microsoft"];
const prepared = new Set();

function isOutlookUrl(url) {
  try {
    const { hostname, host } = new URL(url);
    if (process.env.CC_OUTLOOK_BASE && host === new URL(process.env.CC_OUTLOOK_BASE).host) return true; // tests
    return OUTLOOK_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// Present as the Chrome that Electron is. Without this, Outlook may show an "unsupported browser" page.
function chromeUserAgent() {
  return app.userAgentFallback
    .replace(/\s+Electron\/\S+/, "")
    .replace(new RegExp(`\\s+${app.getName().replace(/\s+/g, "[- ]?")}\\/\\S+`, "i"), "")
    .replace(/\s+calendar-combiner\/\S+/i, "");
}

function prepareSession(partition) {
  const ses = session.fromPartition(partition);
  if (prepared.has(partition)) return ses;
  prepared.add(partition);
  ses.setUserAgent(chromeUserAgent());
  // Applies to every window in the session: the account tab, background sync, sign-in pop-ups.
  ses.registerPreloadScript({ type: "frame", filePath: path.join(__dirname, "account-preload.js") });
  // Notifications would fire twice (visible tab + background sync), and nothing else is needed.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(["clipboard-sanitized-write", "fullscreen"].includes(permission));
  });
  return ses;
}

async function clearSession(partition) {
  const ses = session.fromPartition(partition);
  await ses.clearStorageData();
  await ses.clearCache();
}

module.exports = { isOutlookUrl, prepareSession, clearSession };
