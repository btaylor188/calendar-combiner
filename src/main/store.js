// Small JSON files under the app's user-data directory.
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function file(name) {
  return path.join(app.getPath("userData"), name);
}

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

function write(name, data) {
  const target = file(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

function remove(name) {
  fs.rmSync(file(name), { force: true });
}

module.exports = { read, write, remove, file };
