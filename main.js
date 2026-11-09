"use strict";
const { app, BrowserWindow, ipcMain, shell, safeStorage, Menu } = require("electron");
const path = require("path");
const { Vault } = require("./src/vault");
const { Services, readGoogleClient } = require("./src/services");
const config = require("./src/config");
const { createSplash } = require("./src/splash");
const { runUpdateCheck } = require("./src/updater");

if (!app.requestSingleInstanceLock()) { app.quit(); }

const RENDERER = path.join(__dirname, "renderer");
let win = null, svc = null;
const subscribers = new Set();

/* Windows : chiffrement DPAPI via safeStorage. L'essai sans chiffrement n'existe que hors version installée (essais sous Linux). */
const insecure = () => !app.isPackaged && process.env.AGOA_INSECURE_VAULT === "1";
const cipher = {
  encrypt: (s) => {
    if (insecure()) return Buffer.from(s, "utf8");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Chiffrement Windows indisponible.");
    return safeStorage.encryptString(s);
  },
  decrypt: (b) => (insecure() ? b.toString("utf8") : safeStorage.decryptString(b))
};

function pushToWindow(channel, ...args) { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); }

function boot() {
  const vault = new Vault(path.join(app.getPath("userData"), "vault.json"), cipher);
  const googleClient = readGoogleClient(
    [path.join(process.resourcesPath || "", "google-client.json"), path.join(__dirname, "resources", "google-client.json")], process.env);
  svc = new Services({
    vault, googleClient, ragicProtocol: process.env.AGOA_RAGIC_PROTOCOL || undefined,   // variable réservée aux essais
    openExternal: (url) => shell.openExternal(url),
    log: (m) => console.log("[AGOA ML]", m)
  });
  svc.listeners.add((data) => pushToWindow("data:update", data));
  return svc.startStore().then(() => { svc.syncTimer = setInterval(() => { if (svc.ready && svc.auth.signedIn()) svc.syncGmail().then(() => svc.reconcileAvancement()).catch((e) => console.error(e.message)); }, config.syncMs); });
}

/* Un seul format de réponse : { ok, value } ou { ok:false, code, message } (les erreurs perdent leur code à travers l'IPC). */
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    const url = event.senderFrame && event.senderFrame.url || "";
    if (!url.startsWith("file://") || !decodeURIComponent(url).replace(/\\/g, "/").includes("/renderer/")) return { ok: false, code: "forbidden", message: "Appel refusé." };
    try { return { ok: true, value: await fn(...args) }; }
    catch (e) { return { ok: false, code: e.code || "error", message: e.message || String(e) }; }
  });
}

function registerIpc() {
  handle("app:state", () => svc.state());
  handle("app:setMe", (nom) => svc.setMe(nom));
  handle("auth:signIn", async () => { await svc.auth.signIn(); return svc.state(); });
  handle("auth:signOut", async () => { await svc.signOut(); return svc.state(); });
  handle("ragic:retry", async () => { await svc.startStore(); return svc.state(); });
  handle("data:get", () => svc.snapshot());
  handle("mail:sync", async () => { svc.requireSession(); const r = await svc.syncGmail(); await svc.reconcileAvancement(); return r; });
  handle("mail:statut", (id, s) => svc.setStatut(id, s));
  handle("mail:transfer", (id, to, motif) => svc.transfer(id, to, motif));
  handle("mail:relance", (id, iso) => svc.setRelance(id, iso));
  handle("mail:colonne", (id, nom) => svc.setColonne(id, nom));
  handle("mail:link", (id, l) => svc.link(id, l));
  handle("mail:note", (id, txt) => svc.addNote(id, txt));
  handle("mail:phase", (id, phase, st) => svc.setPhaseStatus(id, phase, st));
  handle("mail:send", (id, m) => svc.send(id, m));
  handle("notif:read", (cle) => svc.markRead(cle));
  handle("mail:thread", (id) => svc.threadDetail(id));
  handle("mail:suggest", (id) => svc.suggest(id));
  handle("mail:merge", (src, dst) => svc.mergeInto(src, dst));
  handle("opt:save", (sheet, rec) => svc.saveRecord(sheet, rec));
  handle("opt:remove", (sheet, key) => svc.removeRecord(sheet, key));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, backgroundColor: "#FAF9F6", title: "AGOA ML", show: false,
    icon: path.join(__dirname, "build", "icon.png"), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file://")) e.preventDefault(); });
  win.on("closed", () => { subscribers.clear(); win = null; });
  win.loadFile(path.join(RENDERER, "index.html"));
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function startup() {
  const noSplash = process.env.AGOA_NO_SPLASH === "1";
  const splash = noSplash ? null : createSplash({ BrowserWindow, version: app.getVersion(), rendererDir: RENDERER });
  const t0 = Date.now();
  let result = { action: "continue" };
  if (splash) {
    let updater = null;
    if (app.isPackaged) { try { updater = require("electron-updater").autoUpdater; } catch (e) { console.error(e); } }
    result = await runUpdateCheck({
      updater: updater || { on() {}, removeListener() {}, checkForUpdates: () => Promise.reject(new Error("indisponible")) },
      onStatus: (s) => splash.status(s), isPackaged: app.isPackaged && !!updater,
      checkTimeoutMs: Number(process.env.AGOA_UPDATE_TIMEOUT_MS) || 12000
    });
    if (result.action === "restart") {
      await sleep(900);
      try { updater.quitAndInstall(false, true); return; } catch (e) { console.error(e); }
    }
    splash.status({ text: "Démarrage…", progress: null });
    const wait = 1200 - (Date.now() - t0); if (wait > 0) await sleep(wait);
  }
  createWindow();
  win.once("ready-to-show", () => { win.show(); if (splash) splash.close(); });
  boot().catch((e) => console.error(e));
}
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  await startup();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) { createWindow(); win.once("ready-to-show", () => win.show()); } });
});
app.on("window-all-closed", () => { if (svc) { clearInterval(svc.syncTimer); svc.stopStore(); } app.quit(); });
