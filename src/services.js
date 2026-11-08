"use strict";
/* Assemble les services de AGOA ML (coffre, Google, Gmail, Ragic) indépendamment d'Electron : testable avec Node seul. */
const fs = require("fs");
const config = require("./config");
const C = require("./core");
const { GoogleAuth } = require("./google");
const { Gmail } = require("./gmail");
const { RagicClient, detectHost } = require("./ragic");
const { MailStore } = require("./store");
const { planSync } = require("./sync");
const { readConnections } = require("./connections");

function readGoogleClient(candidates, env) {
  for (const f of candidates) { try { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.clientId && j.clientSecret) return j; } catch (e) { /* suivant */ } }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  return { clientId: "", clientSecret: "" };
}

const uid = () => "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

class Services {
  constructor({ vault, openExternal, googleClient, fetchImpl, ragicProtocol, connections, log }) {
    this.vault = vault; this.fetchImpl = fetchImpl; this.protocol = ragicProtocol; this.log = log || (() => {});
    this.connections = connections === undefined ? readConnections() : connections;
    this.auth = new GoogleAuth({ clientId: googleClient.clientId, clientSecret: googleClient.clientSecret, scopes: config.googleScopes, allowedDomain: config.allowedDomain, openExternal, vault, fetchImpl });
    this.gmail = new Gmail({ auth: this.auth, fetchImpl });
    this.store = null; this.error = null; this.ready = false; this.starting = false;
    this.data = { mails: [], collaborateurs: [], phases: [], statutsPhase: [], alias: [], avancement: [], regles: [], notifications: [], ops: [], immeubles: [], syndics: [] };
    this.listeners = new Set(); this.timers = [];
  }

  me() { const u = this.auth.user(); return u ? u.email : ""; }
  /** Collaborateur correspondant au compte Google connecté (par e-mail). */
  collaborateur() {
    const e = this.me().toLowerCase();
    return this.data.collaborateurs.find((c) => String(c.email).toLowerCase() === e) || null;
  }

  state() {
    return {
      googleConfigured: this.auth.configured, signedIn: this.auth.signedIn(), user: this.auth.user(), collaborateur: this.collaborateur(),
      ragicConfigured: !!this.connections, ready: this.ready, starting: this.starting, error: this.error, mailbox: config.mailbox, allowedDomain: config.allowedDomain
    };
  }
  emit() { this.listeners.forEach((l) => l(this.snapshot())); }
  snapshot() { return JSON.parse(JSON.stringify(this.data)); }

  /* ---------- démarrage ---------- */
  async startStore() {
    this.stopStore();
    const r = this.connections && this.connections.ragic;
    if (!r || !r.key) { this.error = null; return; }
    this.starting = true;
    try {
      const host = r.host || await detectHost(r.key, { apname: config.ragic.apname, hosts: config.ragic.hosts, probePath: config.ragic.sheets.mails.path, fetchImpl: this.fetchImpl, protocol: this.protocol });
      const client = new RagicClient({ host, apname: r.apname || config.ragic.apname, apiKey: r.key, fetchImpl: this.fetchImpl, protocol: this.protocol });
      this.store = new MailStore({ client, config, log: this.log });
      await this.store.resolveFields();
      await this.reload();
      this.ready = true; this.error = null;
      this.timers.push(setInterval(() => this.reload().catch((e) => this.log("rechargement : " + e.message)), config.ragic.pollMs));
    } catch (e) { this.error = { code: e.code || "error", message: e.message, problems: e.problems }; this.ready = false; this.store = null; }
    finally { this.starting = false; }
  }
  stopStore() { this.timers.forEach(clearInterval); this.timers = []; this.store = null; this.ready = false; }

  async reload() {
    const s = this.store; if (!s) return;
    const [mails, collaborateurs, phases, statutsPhase, alias, avancement, regles, notifications, immeubles, syndics, ops] = await Promise.all([
      s.all("mails"), s.all("collaborateurs"), s.all("phases"), s.all("statutsPhase"), s.all("alias"), s.all("avancement"), s.all("regles"), s.all("notifications"), s.all("immeubles"), s.all("syndics"), s.operations()
    ]);
    const byOrder = (a, b) => (a.ordre || 0) - (b.ordre || 0);
    this.data = {
      mails, collaborateurs: collaborateurs.filter((c) => c.actif !== false), phases: phases.filter((p) => p.actif !== false).sort(byOrder), statutsPhase: statutsPhase.sort(byOrder),
      alias, avancement, regles, notifications, ops,
      immeubles: immeubles.map((i) => ({ code: i.code, syndic: i.syndic, emails: [i.emailGest, i.emailAssist].filter(Boolean) })),
      syndics: syndics.map((x) => ({ nom: x.nom, emails: [x.email].filter(Boolean) }))
    };
    this.emit();
  }

  async signOut() { await this.auth.signOut(); }

  requireStore() { if (!this.store || !this.ready) throw Object.assign(new Error("Base Ragic non connectée."), { code: "not_ready" }); return this.store; }
  requireSession() { if (!this.auth.signedIn()) throw Object.assign(new Error("Connectez-vous à Google."), { code: "needs_reauth" }); }
  who() { const c = this.collaborateur(); return c ? c.nom : this.auth.user() ? this.auth.user().name : ""; }
  valideurs() { return this.data.collaborateurs.filter((c) => c.valideur).map((c) => c.nom); }

  /* ---------- synchronisation Gmail ---------- */
  async syncGmail() {
    this.requireSession(); const s = this.requireStore();
    const list = await this.gmail.listThreads({ q: config.gmailQuery, max: 100 });
    const known = new Map(this.data.mails.map((m) => [m.id, m]));
    const threads = [];
    for (const t of list) { threads.push(await this.gmail.getThread(t.id)); }
    const fresh = threads.filter((t) => { const k = known.get(t.id); return !k || t.messages.length > (k.nb || 0) || (this.data.mails.some((m) => (m.rapproches || []).some((r) => r.thread === t.id))); });
    const plan = planSync(fresh, { mails: this.data.mails, ops: this.data.ops, immeubles: this.data.immeubles, syndics: this.data.syndics, aliases: this.data.alias.map((a) => ({ adresse: a.adresse, collaborateur: a.collaborateur })), aliasList: config.aliases, agencyEmails: [config.mailbox], now: Date.now() });
    for (const m of plan.upserts.values()) await s.upsert("mails", { ...m, modifiePar: "Automatique" });
    for (const n of plan.notifs) await s.create("notifications", { cle: uid(), pour: n.pour, de: n.de, date: new Date(n.t).toISOString(), texte: n.texte, thread: n.thread, lue: false });
    if (plan.upserts.size || plan.notifs.length) await this.reload();
    return { threads: threads.length, updated: plan.upserts.size, notifs: plan.notifs.length };
  }

  /* ---------- actions ---------- */
  async _apply(mail, r, { by } = {}) {
    const s = this.requireStore(), who = by || this.who(), now = Date.now();
    const m = { ...r.mail, journal: [...(r.mail.journal || []), ...r.journal.map((j) => ({ ...j, par: j.par || who }))], modifiePar: who };
    await s.upsert("mails", m);
    for (const n of r.notifs) await s.create("notifications", { cle: uid(), pour: n.pour, de: n.de || who, date: new Date(n.t || now).toISOString(), texte: n.texte, thread: n.thread, lue: false });
    await this.reload();
    return m;
  }
  mailById(id) { const m = this.data.mails.find((x) => x.id === id); if (!m) throw Object.assign(new Error("Fil introuvable."), { code: "not_found" }); return m; }

  async setStatut(id, statut) { this.requireSession(); return this._apply(this.mailById(id), C.setStatut(this.mailById(id), statut, { by: this.who(), ops: this.data.ops, valideurs: this.valideurs(), now: Date.now() })); }
  async transfer(id, to, motif) { this.requireSession(); return this._apply(this.mailById(id), C.transfer(this.mailById(id), to, { by: this.who(), motif, ops: this.data.ops, now: Date.now() })); }
  async setRelance(id, iso) { this.requireSession(); const m = this.mailById(id); return this._apply(m, { mail: { ...m, relance: iso || "" }, journal: [{ t: Date.now(), par: this.who(), texte: iso ? "a programmé une relance" : "a retiré la relance" }], notifs: [] }); }
  async link(id, { imm, op }) {
    this.requireSession(); const m = this.mailById(id), o = op ? this.data.ops.find((x) => x.code === op) : null;
    return this._apply(m, { mail: { ...m, imm: imm || "", op: op || "", opRid: o ? o.rid : 0 }, journal: [{ t: Date.now(), par: this.who(), texte: `a rattaché le fil à ${op || imm || "aucun dossier"}` }], notifs: [] });
  }
  async addNote(id, texte) {
    this.requireSession(); const m = this.mailById(id), by = this.who(), now = Date.now(), txt = String(texte || "").trim();
    if (!txt) throw Object.assign(new Error("Écrivez une note."), { code: "empty" });
    const notifs = [], done = new Set();
    for (const c of this.data.collaborateurs) {
      const handle = c.nom.split(/\s+/)[0];
      if (new RegExp("@" + handle + "(?![A-Za-zÀ-ÿ])", "i").test(txt) && c.nom !== by) { done.add(c.nom); notifs.push({ pour: c.nom, de: by, t: now, texte: `${by} vous a mentionné dans une note : « ${C.short(txt, 70)} »`, thread: id }); }
    }
    const h = C.handler(m, this.data.ops);
    if (h && h !== by && !done.has(h)) notifs.push({ pour: h, de: by, t: now, texte: `${by} a ajouté une note sur « ${C.short(m.objet, 60)} »`, thread: id });
    return this._apply(m, { mail: { ...m, notes: [...(m.notes || []), { auteur: by, t: now, texte: txt }] }, journal: [{ t: now, par: by, texte: "a ajouté une note" }], notifs });
  }

  /** Statut d'une phase pour un fil : enregistré dans Avancement opérations, puis règles vers OPERATIONS si la fiche existe. */
  async setPhaseStatus(id, phase, statutPhase) {
    this.requireSession(); const s = this.requireStore(), m = this.mailById(id), by = this.who(), now = Date.now();
    const code = m.op || m.imm; if (!code) throw Object.assign(new Error("Rattachez d’abord le fil à un immeuble ou une opération."), { code: "no_link" });
    const o = m.op ? this.data.ops.find((x) => x.code === m.op) : null;
    await s.upsert("avancement", { cle: `${code}|${phase}`, codeOp: code, imm: m.imm, phase, statutPhase, date: new Date(now).toISOString(), par: by, thread: id, opRid: o ? o.rid : 0 });
    let applied = { applied: 0, unknown: [] };
    if (o) {
      const updates = C.applyRules(this.data.regles, phase, statutPhase, { today: new Date(now).toISOString(), user: by });
      if (updates.length) applied = await s.updateOperation(o.rid, updates);
    }
    const r = { mail: { ...m, phase }, journal: [{ t: now, par: by, texte: `a passé la phase « ${phase} » de ${code} à « ${statutPhase} »${applied.applied ? " (fiche OPERATIONS mise à jour)" : o ? "" : " (opération pas encore dans Ragic : information conservée)"}` }], notifs: [] };
    const a = C.archiOf(m, this.data.ops); if (a && a !== by) r.notifs.push({ pour: a, de: by, t: now, texte: `Phase « ${phase} » de ${code} : ${statutPhase} (par ${by})`, thread: id });
    await this._apply(m, r);
    return applied;
  }

  /** Rattache les lignes d'avancement créées avant l'opération Ragic, puis applique les règles. */
  async reconcileAvancement() {
    const s = this.requireStore(); let n = 0;
    for (const a of this.data.avancement) {
      if (a.opRid) continue;
      const o = this.data.ops.find((x) => x.code === a.codeOp); if (!o) continue;
      await s.upsert("avancement", { ...a, opRid: o.rid });
      const updates = C.applyRules(this.data.regles, a.phase, a.statutPhase, { today: a.date || new Date().toISOString(), user: a.par });
      if (updates.length) await s.updateOperation(o.rid, updates);
      n++;
    }
    if (n) await this.reload();
    return n;
  }

  /** Envoi réel par Gmail, puis mise à jour du fil (statut « En attente » si demandé). */
  async send(id, { to = [], cc = [], bcc = [], subject, body, from, mode }) {
    this.requireSession(); const m = this.mailById(id);
    if (!to.length && !bcc.length) throw Object.assign(new Error("Ajoutez au moins un destinataire."), { code: "empty" });
    await this.gmail.send({ from: from || config.mailbox, to, cc, bcc, subject: subject || m.objet, body, threadId: m.id });
    const dest = [...to, ...cc, ...bcc].map((e) => ({ email: e, nom: "" }));
    const r = C.afterSend(m, { destinataires: dest, mode, by: this.who(), ops: this.data.ops, now: Date.now(), nbCci: bcc.length });
    return this._apply(m, r);
  }

  async markRead(cle) { const s = this.requireStore(); const n = this.data.notifications.find((x) => x.cle === cle); if (n) { await s.upsert("notifications", { ...n, lue: true }); await this.reload(); } }
}

module.exports = { Services, readGoogleClient };
