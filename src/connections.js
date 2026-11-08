"use strict";
/* Connexions partagées du lanceur AGOA (Ragic, Google) : variables d'environnement transmises par le lanceur,
   sinon lecture de C:\AGOA\_connexions\connexions.dat (chiffré DPAPI, utilisateur courant) via PowerShell. */
const { execFileSync } = require("child_process");

const FILE = "C:\\AGOA\\_connexions\\connexions.dat";

function fromEnv(env) {
  if (!env.AGOA_RAGIC_KEY) return null;
  const out = { ragic: { key: env.AGOA_RAGIC_KEY, host: env.AGOA_RAGIC_HOST || "", apname: env.AGOA_RAGIC_APNAME || "agoa" } };
  if (env.AGOA_GOOGLE_REFRESH_TOKEN) out.google = { refresh_token: env.AGOA_GOOGLE_REFRESH_TOKEN, email: env.AGOA_GOOGLE_EMAIL || "", client_id: env.AGOA_GOOGLE_CLIENT_ID || "" };
  return out;
}

function fromFile(file = FILE, exec = execFileSync) {
  if (process.platform !== "win32" && exec === execFileSync) return null;
  const ps = `Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes('${file}'),$null,'CurrentUser'))`;
  try { return JSON.parse(exec("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true }).toString()); } catch (e) { return null; }
}

/** Retourne { ragic:{key,host,apname}, google?:{…} } ou null (ouvrir le lanceur pour enregistrer la clé). */
function readConnections(env = process.env, opts = {}) {
  const e = fromEnv(env);
  if (e) return e;
  const f = fromFile(opts.file, opts.exec);
  return f && f.ragic && f.ragic.key ? f : null;
}

module.exports = { readConnections, fromEnv, fromFile };
