"use strict";
/* Coffre local : petit fichier JSON dont chaque valeur est chiffrée (Windows : DPAPI, via safeStorage d'Electron). */
const fs = require("fs");
const path = require("path");

class Vault {
  /** cipher : { encrypt(str) -> Buffer, decrypt(Buffer) -> str } */
  constructor(file, cipher) { this.file = file; this.cipher = cipher; this.cache = null; }
  _load() {
    if (this.cache) return this.cache;
    try { this.cache = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch (e) { this.cache = {}; }
    return this.cache;
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache), { mode: 0o600 });
  }
  get(name) {
    const v = this._load()[name]; if (!v) return null;
    try { return this.cipher.decrypt(Buffer.from(v, "base64")); } catch (e) { return null; }
  }
  set(name, value) { this._load()[name] = this.cipher.encrypt(String(value)).toString("base64"); this._save(); }
  remove(name) { delete this._load()[name]; this._save(); }
}
module.exports = { Vault };
