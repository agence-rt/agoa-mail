"use strict";
/* Essai de lancement réel (Linux : xvfb-run npx electron --no-sandbox scripts/electron-smoke.js avec AGOA_SHOT_DIR=dossier).
   Vérifie que la fenêtre s'ouvre, que le préchargement expose window.agoa et que l'IPC répond. */
const { app } = require("electron");
const fs = require("fs"); const os = require("os"); const path = require("path");
const out = process.env.AGOA_SHOT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "agoa-shot-"));
fs.mkdirSync(out, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "agoa-ud-")));
process.env.AGOA_NO_SPLASH = "1";
require("../main.js");

app.on("browser-window-created", (_e, win) => {
  win.webContents.once("did-finish-load", async () => {
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const probe = await win.webContents.executeJavaScript(`(async () => ({
        hasAgoa: typeof window.agoa === "object", keys: Object.keys(window.agoa || {}),
        state: await window.agoa.state(), title: document.title, h1: (document.querySelector("h1")||{}).textContent,
        nodeLeak: typeof require !== "undefined" || typeof process !== "undefined"
      }))()`);
      console.log("SMOKE", JSON.stringify(probe));
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, "gate.png"), img.toPNG());
      console.log("SHOT", path.join(out, "gate.png"));
      app.exit(probe.hasAgoa && probe.state && !probe.nodeLeak ? 0 : 2);
    } catch (e) { console.error("SMOKE-ERR", e); app.exit(3); }
  });
});
