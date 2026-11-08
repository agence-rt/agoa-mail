"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("splash", {
  onStatus: (fn) => ipcRenderer.on("splash:status", (_e, s) => fn(s))
});
