"use strict";
/* Accès aux feuilles Ragic de AGOA ML. Les champs sont retrouvés par leur libellé (schéma Ragic).
   Les listes (notes, journal, réponses attendues, fils rapprochés) sont stockées en JSON dans des champs texte. */
const { EventEmitter } = require("events");
const { norm } = require("./core");
const config = require("./config");

const TRUE_RE = /^(yes|oui|true|1|x|vrai|on)$/i;
const pad = (n) => String(n).padStart(2, "0");
const toRagicDT = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const fromRagicDT = (s) => {
  const m = String(s || "").match(/(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).toISOString() : "";
};

/* type de chaque champ logique (str par défaut) */
const TYPES = {
  statut: "statut", attendu: "json", notes: "json", journal: "json", rapproches: "json",
  nb: "num", opRid: "num", ordre: "num",
  valideur: "bool", actif: "bool", lue: "bool", systeme: "bool", defaut: "bool",
  dernier: "dt", attenteDepuis: "dt", date: "dt", relance: "dt"
};
const conv = {
  str: { r: (v) => (v == null ? "" : String(v)), w: (v) => (v == null ? "" : String(v)) },
  num: { r: (v) => { const n = Number(String(v == null ? "" : v).replace(",", ".")); return String(v == null ? "" : v).trim() !== "" && Number.isFinite(n) ? n : 0; }, w: (v) => (v === "" || v == null || v === 0 ? "" : String(v)) },
  bool: { r: (v) => TRUE_RE.test(String(v == null ? "" : v).trim()), w: (v, c) => (v ? c.boolTrue : c.boolFalse) },
  dt: { r: fromRagicDT, w: (v) => (v ? toRagicDT(v) : "") },
  statut: {
    r: (v) => { const k = norm(v); const hit = Object.entries(config.statutsRagic).find(([id, l]) => norm(l) === k || id === k || norm(l).replace(/\s+/g, "-") === k); return hit ? hit[0] : "nouveau"; },
    w: (v) => config.statutsRagic[v] || String(v || "")
  },
  json: { r: (v) => { try { const o = JSON.parse(String(v || "")); return Array.isArray(o) ? o : []; } catch (e) { return []; } }, w: (v) => (Array.isArray(v) && v.length ? JSON.stringify(v) : "") }
};
const typeOf = (k) => TYPES[k] || "str";

class MailStore extends EventEmitter {
  constructor({ client, config, log }) {
    super();
    this.client = client; this.cfg = config.ragic; this.log = log || (() => {});
    this.f = {};                 // feuille -> { logique: idChamp }
    this.opFields = new Map();   // libellé normalisé -> idChamp (feuille OPERATIONS)
    this.rids = {};              // feuille -> Map(clé -> rid)
  }

  sheetDef(name) { return this.cfg.sheets[name] || this.cfg[name]; }

  /* ---------- champs ---------- */
  async resolveFields() {
    const problems = [];
    const names = [...Object.keys(this.cfg.sheets), "immeubles", "syndics"];
    for (const name of names) {
      const def = this.sheetDef(name);
      let byLabel = new Map();
      try { (await this.client.schema(def.path)).forEach((x) => byLabel.set(norm(x.fieldName), x.fieldId)); }
      catch (e) {
        if (e.code === "auth" && e.status === 401) throw e;
        if (def.optional) { this.f[name] = null; continue; }
        if (e.code === "not_found") { problems.push(`feuille introuvable : ${def.path} (${name})`); continue; }
        problems.push(`schéma illisible pour ${def.path} : ${e.message}`); continue;
      }
      const map = {}, missing = [];
      for (const [logical, d] of Object.entries(def.fields)) {
        const id = byLabel.get(norm(d.label));
        if (id) map[logical] = Number(id); else if (!d.optional) missing.push(d.label);
      }
      if (missing.length && def.optional) { this.f[name] = null; continue; }
      if (missing.length) problems.push(`${def.path} (${name}) : champ(s) manquant(s) ${missing.map((m) => "« " + m + " »").join(", ")}`);
      this.f[name] = map;
    }
    try { (await this.client.schema(this.cfg.operations.path)).forEach((x) => this.opFields.set(norm(x.fieldName), Number(x.fieldId))); } catch (e) { this.log("schéma OPERATIONS illisible : " + e.message); }
    if (problems.length) { const err = new Error("Base Ragic incomplète : " + problems.join(" ; ") + "."); err.code = "missing_field"; err.problems = problems; throw err; }
  }

  /* ---------- conversion ---------- */
  toDoc(name, rec) {
    const f = this.f[name], d = {};
    for (const k of Object.keys(f)) d[k] = conv[typeOf(k)].r(rec[f[k]]);
    d._rid = rec._ragicId;
    return d;
  }
  toFields(name, data) {
    const f = this.f[name], out = {};
    for (const [k, v] of Object.entries(data)) if (f[k] && !k.startsWith("_")) out[f[k]] = conv[typeOf(k)].w(v, this.cfg);
    return out;
  }

  /* ---------- lecture ---------- */
  has(name) { return !!this.f[name]; }
  async all(name) {
    if (!this.f[name]) return [];
    const recs = await this.client.list(this.sheetDef(name).path);
    const docs = recs.map((r) => this.toDoc(name, r));
    const key = this.sheetDef(name).key;
    if (key) this.rids[name] = new Map(docs.map((d) => [d[key], d._rid]));
    return docs;
  }

  /** Opérations Ragic (CODE TRAVAUX, immeuble, architecte) pour la détection et la désignation du responsable. */
  async operations({ onlyActive = false } = {}) {
    const o = this.cfg.operations;
    const recs = await this.client.list(o.path, { fetchIds: [o.code, o.imm, o.indice, o.statut, o.architecte, o.suivi] });
    return recs.map((r) => ({ rid: r._ragicId, code: String(r[o.code] || "").trim(), imm: String(r[o.imm] || "").trim(), indice: String(r[o.indice] || "").trim(), statut: String(r[o.statut] || "").trim(), archi: String(r[o.architecte] || "").trim(), suivi: String(r[o.suivi] || "").trim() }))
      .filter((x) => x.code && (!onlyActive || /actif/i.test(x.statut)));
  }

  /* ---------- écriture ---------- */
  /** Crée ou met à jour la fiche de clé `keyValue`. Retourne le rid. */
  async upsert(name, data) {
    const def = this.sheetDef(name), key = def.key;
    if (!key) throw new Error("Feuille sans clé : " + name);
    if (!this.rids[name]) await this.all(name);
    const rid = this.rids[name].get(data[key]);
    const fields = this.toFields(name, data);
    if (rid) { await this.client.update(def.path, rid, fields); return rid; }
    let nrid = await this.client.create(def.path, fields);
    if (!nrid) {   // Ragic n'a pas renvoyé l'identifiant : on relit la feuille pour retrouver la fiche par sa clé
      this.rids[name] = null; await this.all(name);
      nrid = this.rids[name] && this.rids[name].get(data[key]);
      if (!nrid) throw new Error(`Ragic n’a pas créé la fiche dans « ${name} » (${def.path}, ${Object.keys(fields).length} champs envoyés ; réponse : ${JSON.stringify(this.client.lastCreate).slice(0, 160)}). Vérifiez les droits d’écriture de la clé Ragic et les champs obligatoires de la feuille.`);
    }
    this.rids[name].set(data[key], nrid);
    return nrid;
  }
  async create(name, data) { return this.client.create(this.sheetDef(name).path, this.toFields(name, data)); }
  async removeByKey(name, keyValue) {
    const rid = this.rids[name] && this.rids[name].get(keyValue); if (!rid) return;
    await this.client.remove(this.sheetDef(name).path, rid); this.rids[name].delete(keyValue);
  }

  /** Applique les modifications issues des règles à une fiche OPERATIONS existante. updates : [{champ, action, valeur}]. */
  async updateOperation(rid, updates) {
    const o = this.cfg.operations, out = {}, unknown = [];
    let current = null;
    for (const u of updates) {
      const id = this.opFields.get(norm(u.champ));
      if (!id) { unknown.push(u.champ); continue; }
      if (u.action === "Remplacer") { out[id] = u.valeur; continue; }
      if (!current) current = (await this.client.get(o.path, rid).catch(() => null)) || {};
      const list = String(out[id] != null ? out[id] : current[id] || "").split(",").map((s) => s.trim()).filter(Boolean);
      const next = u.action === "Ajouter à la liste" ? (list.includes(u.valeur) ? list : [...list, u.valeur]) : list.filter((x) => x !== u.valeur);
      out[id] = next.join(",");
    }
    if (Object.keys(out).length) await this.client.update(o.path, rid, out);
    return { applied: Object.keys(out).length, unknown };
  }
}

module.exports = { MailStore, toRagicDT, fromRagicDT, conv, TYPES };
