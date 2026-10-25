const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cc", {
  listAccounts: () => ipcRenderer.invoke("accounts:list"),
  addAccount: (account) => ipcRenderer.invoke("accounts:add", account),
  updateAccount: (id, patch) => ipcRenderer.invoke("accounts:update", id, patch),
  removeAccount: (id) => ipcRenderer.invoke("accounts:remove", id),
  show: (target, date) => ipcRenderer.invoke("view:show", target, date),
  reloadAccount: (id) => ipcRenderer.invoke("view:reload", id),
  getEvents: (start, end) => ipcRenderer.invoke("events:get", start, end),
  refresh: (start, end) => ipcRenderer.invoke("events:refresh", start, end),
  onAccounts: (cb) => ipcRenderer.on("accounts", (_e, accounts) => cb(accounts)),
  onEvents: (cb) => ipcRenderer.on("events", () => cb()),
});
