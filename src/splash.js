"use strict";
/* Fenêtre d'accueil (écran de chargement) : logo, nom, état de la recherche de mises à jour, version. */
const path = require("path");

function createSplash({ BrowserWindow, version, rendererDir }) {
  const win = new BrowserWindow({
    width: 645, height: 410, frame: false, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
    show: false, center: true, backgroundColor: "#ffffff", title: "AGOA TD",
    icon: path.join(rendererDir, "..", "build", "icon.png"),
    webPreferences: { preload: path.join(rendererDir, "splash-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  let loaded = false, last = { text: "Démarrage…", progress: null };
  const push = () => { if (loaded && !win.isDestroyed()) win.webContents.send("splash:status", last); };
  win.webContents.once("did-finish-load", () => { loaded = true; push(); });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(rendererDir, "splash.html"), { query: { v: version } });
  return {
    win,
    status(s) { last = { text: s.text, progress: s.progress == null ? null : s.progress }; push(); },
    close() { if (!win.isDestroyed()) win.close(); }
  };
}

module.exports = { createSplash };
