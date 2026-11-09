"use strict";
const { contextBridge, ipcRenderer } = require("electron");

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && r.ok) return r.value;
  const err = new Error((r && r.message) || "Erreur"); err.code = (r && r.code) || "error"; throw err;
}
const handlers = [];
ipcRenderer.on("data:update", (_e, data) => handlers.forEach((fn) => fn(data)));

contextBridge.exposeInMainWorld("agoa", {
  state: () => call("app:state"),
  setMe: (nom) => call("app:setMe", nom),
  signIn: () => call("auth:signIn"),
  signOut: () => call("auth:signOut"),
  retry: () => call("ragic:retry"),
  data: () => call("data:get"),
  onData: (fn) => { handlers.push(fn); },
  sync: () => call("mail:sync"),
  setStatut: (id, s) => call("mail:statut", id, s),
  transfer: (id, to, motif) => call("mail:transfer", id, to, motif),
  setRelance: (id, iso) => call("mail:relance", id, iso),
  setColonne: (id, nom) => call("mail:colonne", id, nom),
  link: (id, l) => call("mail:link", id, l),
  addNote: (id, txt) => call("mail:note", id, txt),
  setPhase: (id, phase, st) => call("mail:phase", id, phase, st),
  send: (id, m) => call("mail:send", id, m),
  markRead: (cle) => call("notif:read", cle),
  thread: (id) => call("mail:thread", id),
  suggest: (id) => call("mail:suggest", id),
  mergeInto: (src, dst) => call("mail:merge", src, dst),
  saveRecord: (sheet, rec) => call("opt:save", sheet, rec),
  removeRecord: (sheet, key) => call("opt:remove", sheet, key)
});
