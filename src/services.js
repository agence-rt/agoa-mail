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
    this._seedGoogle(googleClient);
    this.store = null; this.error = null; this.ready = false; this.starting = false;
    this.data = { mails: [], colonnes: [], collaborateurs: [], phases: [], statutsPhase: [], alias: [], avancement: [], regles: [], notifications: [], ops: [], immeubles: [], syndics: [] };
    this.listeners = new Set(); this.timers = [];
  }

  /** Tout le monde utilise le même compte Google (agence@) : le jeton du lanceur est repris tel quel, sans nouvelle connexion. */
  _seedGoogle(googleClient) {
    const g = this.connections && this.connections.google;
    if (!g || !g.refresh_token || this.auth.signedIn() || !googleClient.clientId) return;
    if (g.client_id && g.client_id !== googleClient.clientId) { this.log("jeton Google du lanceur émis pour un autre client_id : connexion manuelle"); return; }
    if (this.vault.get("google_rejected") === g.refresh_token) return;   // déjà refusé par Google : connexion manuelle
    if (g.scopes && !String(g.scopes).includes("gmail.modify")) { this.log("jeton Google du lanceur limité à l’envoi (pas de gmail.modify) : connexion Google à faire dans l’application"); return; }
    const email = String(g.email || "").toLowerCase();
    if (!email.endsWith("@" + config.allowedDomain)) return;
    this.vault.set("google_refresh", g.refresh_token);
    this.vault.set("google_profile", JSON.stringify({ email, name: g.name || email, picture: "", canSend: String(g.scopes || "").includes("gmail.send") || undefined }));
  }

  /** « Qui suis-je ? » : le compte Google est commun, on retient sur ce poste le collaborateur choisi. */
  collaborateur() {
    const nom = this.vault.get("me");
    return (nom && this.data.collaborateurs.find((c) => c.nom === nom)) || null;
  }
  setMe(nom) {
    if (!this.data.collaborateurs.some((c) => c.nom === nom)) throw Object.assign(new Error("Collaborateur inconnu."), { code: "not_found" });
    this.vault.set("me", nom); this._sig = null; this.emit();
    return this.state();
  }

  state() {
    return {
      googleConfigured: this.auth.configured, signedIn: this.auth.signedIn(), user: this.auth.user(), collaborateur: this.collaborateur(), collaborateurs: this.data.collaborateurs.map((c) => c.nom),
      ragicConfigured: !!this.connections, kanban: this.kanbanAvailable(), ready: this.ready, starting: this.starting, error: this.error, mailbox: config.mailbox, allowedDomain: config.allowedDomain
    };
  }
  kanbanAvailable() { return !!(this.store && this.store.has("colonnes") && this.store.f.mails && this.store.f.mails.colonne); }
  defaultColumn() { const c = this.data.colonnes.find((x) => x.defaut) || this.data.colonnes[0]; return c ? c.libelle : config.colonneParDefaut; }
  emit() { const sig = JSON.stringify(this.data); if (sig === this._sig) return; this._sig = sig; this.listeners.forEach((l) => l(this.snapshot())); }
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
      this.timers.push(setInterval(() => this.reload("live").catch((e) => this.log("rechargement : " + e.message)), config.ragic.pollMs));
    } catch (e) { this.error = { code: e.code || "error", message: e.message, problems: e.problems }; this.ready = false; this.store = null; }
    finally { this.starting = false; }
  }
  stopStore() { this.timers.forEach(clearInterval); this.timers = []; this.store = null; this.ready = false; }

  /** Recharge depuis Ragic. « live » : fils, notifications, avancement (3 requêtes). « all » : tout (référentiels compris, ~12 requêtes). */
  async reload(scope = "all") {
    const s = this.store; if (!s) return;
    if (scope === "live" && this._staticAt) {
      const [mails, notifications, avancement] = await Promise.all([s.all("mails"), s.all("notifications"), s.all("avancement")]);
      this.data = { ...this.data, mails, notifications, avancement };
      this.emit();
      if (Date.now() - this._staticAt > config.ragic.staticMs) this.reload("all").catch((e) => this.log("rechargement : " + e.message));
      return;
    }
    this._staticAt = Date.now();
    const [mails, colonnes, collaborateurs, phases, statutsPhase, alias, avancement, regles, notifications, immeubles, syndics, ops] = await Promise.all([
      s.all("mails"), s.all("colonnes"), s.all("collaborateurs"), s.all("phases"), s.all("statutsPhase"), s.all("alias"), s.all("avancement"), s.all("regles"), s.all("notifications"), s.all("immeubles"), s.all("syndics"), s.operations()
    ]);
    const byOrder = (a, b) => (a.ordre || 0) - (b.ordre || 0);
    const actifs = collaborateurs.filter((c) => c.actif !== false);
    const resolve = (txt) => {   // « Architecte ? » est un prénom libre dans OPERATIONS : on le relie au collaborateur
      const t = C.norm(txt); if (!t) return "";
      const c = actifs.find((x) => C.norm(x.nom) === t) || actifs.find((x) => C.norm(x.nom.split(/\s+/)[0]) === t);
      return c ? c.nom : String(txt).trim();
    };
    this.data = {
      mails, colonnes: colonnes.filter((c) => c.actif !== false).sort(byOrder), collaborateurs: collaborateurs.filter((c) => c.actif !== false), phases: phases.filter((p) => p.actif !== false).sort(byOrder), statutsPhase: statutsPhase.sort(byOrder),
      alias, avancement, regles, notifications, ops: ops.map((o) => ({ ...o, archi: resolve(o.archi) })),
      immeubles: immeubles.map((i) => ({ code: i.code, syndic: i.syndic, emails: [i.emailGest, i.emailAssist].filter(Boolean) })),
      syndics: syndics.map((x) => ({ nom: x.nom, emails: [x.email].filter(Boolean) }))
    };
    if (!this.data.colonnes.length) this.data.colonnes = [{ libelle: config.colonneParDefaut, ordre: 1, couleur: "Gris", actif: true, defaut: true }];
    this.emit();
  }

  async signOut() { await this.auth.signOut(); }

  requireStore() { if (!this.store || !this.ready) throw Object.assign(new Error("Base Ragic non connectée."), { code: "not_ready" }); return this.store; }
  requireSession() { if (!this.auth.signedIn()) throw Object.assign(new Error("Connectez-vous à Google."), { code: "needs_reauth" }); }
  requireActor() { this.requireSession(); if (!this.who()) throw Object.assign(new Error("Choisissez d’abord qui vous êtes (en haut à droite)."), { code: "no_actor" }); }
  who() { const c = this.collaborateur(); return c ? c.nom : ""; }
  valideurs() { return this.data.collaborateurs.filter((c) => c.valideur).map((c) => c.nom); }

  /* ---------- synchronisation Gmail ---------- */
  async syncGmail() {
    this.requireSession(); const s = this.requireStore();
    const list = await this.gmail.listThreads({ q: config.gmailQuery, max: 100 });
    const known = new Map(this.data.mails.map((m) => [m.id, m]));
    this._hist = this._hist || new Map();
    const todo = list.filter((t) => !(t.historyId && this._hist.get(t.id) === t.historyId && known.has(t.id)));   // fil inchangé depuis la dernière synchro : pas de relecture Gmail
    const threads = [];
    for (let i = 0; i < todo.length; i += 6) threads.push(...await Promise.all(todo.slice(i, i + 6).map((t) => this.gmail.getThread(t.id).then((g) => { if (t.historyId) this._hist.set(t.id, t.historyId); return g; }))));
    const fresh = threads.filter((t) => { const k = known.get(t.id); return !k || t.messages.length > (k.nb || 0) || (this.data.mails.some((m) => (m.rapproches || []).some((r) => r.thread === t.id))); });
    const plan = planSync(fresh, { mails: this.data.mails, ops: this.data.ops, immeubles: this.data.immeubles, syndics: this.data.syndics, aliases: this.data.alias.map((a) => ({ adresse: a.adresse, collaborateur: a.collaborateur })), aliasList: config.aliases, agencyEmails: [config.mailbox], now: Date.now(), defaultCol: this.defaultColumn(), colNames: this.data.colonnes.map((c) => c.libelle) });
    const ups = [...plan.upserts.values()];
    for (let i = 0; i < ups.length; i += 4) await Promise.all(ups.slice(i, i + 4).map((m) => s.upsert("mails", { ...m, modifiePar: "Automatique" })));
    for (let i = 0; i < plan.notifs.length; i += 4) await Promise.all(plan.notifs.slice(i, i + 4).map((n) => s.create("notifications", { cle: uid(), pour: n.pour, de: n.de, date: new Date(n.t).toISOString(), texte: n.texte, thread: n.thread, lue: false })));
    if (plan.upserts.size || plan.notifs.length) await this.reload("live");
    return { threads: threads.length, updated: plan.upserts.size, notifs: plan.notifs.length };
  }

  /* ---------- actions ---------- */
  /** Écrit un fil modifié. L'écran est mis à jour tout de suite (copie locale), l'écriture Ragic suit sans tout recharger ; en cas d'échec on relit Ragic. */
  async _apply(mail, r, { by } = {}) {
    const s = this.requireStore(), who = by || this.who(), now = Date.now();
    const m = { ...r.mail, journal: [...(r.mail.journal || []), ...r.journal.map((j) => ({ ...j, par: j.par || who }))], modifiePar: who };
    const notifs = r.notifs.map((n) => ({ cle: uid(), pour: n.pour, de: n.de || who, date: new Date(n.t || now).toISOString(), texte: n.texte, thread: n.thread, lue: false }));
    this.data = { ...this.data, mails: this.data.mails.map((x) => (x.id === m.id ? { ...x, ...m } : x)), notifications: [...notifs, ...this.data.notifications] };
    this.emit();
    try { await Promise.all([s.upsert("mails", m), ...notifs.map((n) => s.create("notifications", n))]); }
    catch (e) { await this.reload("live").catch(() => {}); throw e; }
    return m;
  }
  mailById(id) { const m = this.data.mails.find((x) => x.id === id); if (!m) throw Object.assign(new Error("Fil introuvable."), { code: "not_found" }); return m; }

  async setStatut(id, statut) { this.requireActor(); return this._apply(this.mailById(id), C.setStatut(this.mailById(id), statut, { by: this.who(), ops: this.data.ops, valideurs: this.valideurs(), now: Date.now() })); }
  async transfer(id, to, motif) { this.requireActor(); return this._apply(this.mailById(id), C.transfer(this.mailById(id), to, { by: this.who(), motif, ops: this.data.ops, now: Date.now() })); }
  async setColonne(id, nom) {
    this.requireActor();
    if (!this.kanbanAvailable()) throw Object.assign(new Error("Créez la feuille Colonnes et le champ « Colonne » dans Mails (voir le README)."), { code: "no_kanban" });
    if (!this.data.colonnes.some((c) => c.libelle === nom)) throw Object.assign(new Error("Colonne inconnue."), { code: "not_found" });
    const m = this.mailById(id); return this._apply(m, C.setColonne(m, nom, { by: this.who(), now: Date.now() }));
  }
  async setRelance(id, iso) { this.requireActor(); const m = this.mailById(id); return this._apply(m, { mail: { ...m, relance: iso || "" }, journal: [{ t: Date.now(), par: this.who(), texte: iso ? "a programmé une relance" : "a retiré la relance" }], notifs: [] }); }
  async link(id, { imm, op }) {
    this.requireActor(); const m = this.mailById(id), o = op ? this.data.ops.find((x) => x.code === op) : null;
    return this._apply(m, { mail: { ...m, imm: imm || "", op: op || "", opRid: o ? o.rid : 0 }, journal: [{ t: Date.now(), par: this.who(), texte: `a rattaché le fil à ${op || imm || "aucun dossier"}` }], notifs: [] });
  }
  async addNote(id, texte) {
    this.requireActor(); const m = this.mailById(id), by = this.who(), now = Date.now(), txt = String(texte || "").trim();
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
    this.requireActor(); const s = this.requireStore(), m = this.mailById(id), by = this.who(), now = Date.now();
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
    await this.reload("live");   // l'avancement vient d'être écrit : on le relit
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
    this.requireActor(); const m = this.mailById(id);
    if (!to.length && !bcc.length) throw Object.assign(new Error("Ajoutez au moins un destinataire."), { code: "empty" });
    await this.gmail.send({ from: from || config.mailbox, to, cc, bcc, subject: subject || m.objet, body, threadId: m.id });
    const dest = [...to, ...cc, ...bcc].map((e) => ({ email: e, nom: "" }));
    const r = C.afterSend(m, { destinataires: dest, mode, by: this.who(), ops: this.data.ops, now: Date.now(), nbCci: bcc.length });
    return this._apply(m, r);
  }


  /* ---------- lecture du détail d'un fil (messages Gmail) et suggestions ---------- */
  async threadDetail(id) { this.requireSession(); return this.gmail.getThread(id); }
  suggest(id) {
    const m = this.mailById(id), ctx = { immeubles: this.data.immeubles, operations: this.data.ops, syndics: this.data.syndics };
    const det = !m.imm ? C.detect({ objet: m.objet, expEmail: m.expEmail }, ctx) : null;
    const w = C.findWaiting(this.data.mails, m.expEmail, m.id);
    return { detect: det, waiting: w && !(m.attendu || []).length ? { id: w.id, objet: w.objet } : null };
  }
  /** Rapproche un fil d'un fil « En attente » : le fil source est mémorisé dans Fils rapprochés. */
  async mergeInto(srcId, dstId) {
    this.requireActor(); const src = this.mailById(srcId), dst = this.mailById(dstId);
    const r = C.onIncoming(dst, { email: src.expEmail, nom: src.expediteur, objet: src.objet }, { ops: this.data.ops, now: Date.now(), separate: true, srcThread: src.id });
    await this._apply(dst, r);
    await this.requireStore().removeByKey("mails", src.id).catch(() => {});
    await this.reload();
  }

  /* ---------- options : collaborateurs, phases, statuts de phase, alias ---------- */
  async saveRecord(sheet, rec) {
    this.requireActor(); const s = this.requireStore();
    if (!["collaborateurs", "phases", "statutsPhase", "alias", "colonnes"].includes(sheet)) throw Object.assign(new Error("Feuille non modifiable."), { code: "forbidden" });
    if (sheet === "colonnes" && !this.kanbanAvailable()) throw Object.assign(new Error("Créez d’abord la feuille Colonnes et le champ « Colonne » dans Mails (voir le README)."), { code: "no_kanban" });
    const key = s.sheetDef(sheet).key;
    if (!String(rec[key] || "").trim()) throw Object.assign(new Error("Le nom est obligatoire."), { code: "empty" });
    if (rec._renameFrom) {   // renommage : on met à jour la fiche existante (même rid), la clé change
      const rid = s.rids[sheet] && s.rids[sheet].get(rec._renameFrom);
      if (rid) { await s.client.update(s.sheetDef(sheet).path, rid, s.toFields(sheet, rec)); s.rids[sheet].delete(rec._renameFrom); s.rids[sheet].set(rec[key], rid); }
      if (sheet === "collaborateurs") await this._renameCollab(rec._renameFrom, rec[key]);
      if (sheet === "colonnes") for (const m of this.data.mails) if (m.colonne === rec._renameFrom) await s.upsert("mails", { ...m, colonne: rec[key] });
    } else await s.upsert(sheet, rec);
    if (sheet === "colonnes" && rec.defaut) for (const c of this.data.colonnes) if (c.defaut && c.libelle !== (rec[key])) await s.upsert("colonnes", { ...c, defaut: false });
    await this.reload();
  }
  async _renameCollab(from, to) {
    const s = this.requireStore();
    for (const m of this.data.mails) if (m.assigne === from) await s.upsert("mails", { ...m, assigne: to });
  }
  /** Supprimer un collaborateur : tous ses fils passent « non attribués ». Les opérations Ragic ne sont pas modifiées. */
  async removeRecord(sheet, keyValue) {
    this.requireActor(); const s = this.requireStore();
    if (!["collaborateurs", "phases", "statutsPhase", "alias", "colonnes"].includes(sheet)) throw Object.assign(new Error("Feuille non modifiable."), { code: "forbidden" });
    if (sheet === "colonnes") {
      const col = this.data.colonnes.find((c) => c.libelle === keyValue), def = this.defaultColumn();
      if (col && col.defaut) throw Object.assign(new Error("La colonne par défaut ne peut pas être supprimée : désignez-en une autre d’abord."), { code: "forbidden" });
      for (const m of this.data.mails) if (m.colonne === keyValue) await s.upsert("mails", { ...m, colonne: def, modifiePar: this.who() });
    }
    if (sheet === "collaborateurs") {
      for (const m of this.data.mails) if (m.assigne === keyValue) await s.upsert("mails", { ...m, assigne: "", modifiePar: this.who() });
      for (const n of this.data.notifications) if (n.pour === keyValue) await s.removeByKey("notifications", n.cle).catch(() => {});
    }
    await s.removeByKey(sheet, keyValue);
    await this.reload();
  }

  async markRead(cle) { const s = this.requireStore(); const n = this.data.notifications.find((x) => x.cle === cle); if (n) { this.data = { ...this.data, notifications: this.data.notifications.map((x) => (x.cle === cle ? { ...x, lue: true } : x)) }; this.emit(); try { await s.upsert("notifications", { ...n, lue: true }); } catch (e) { await this.reload("live").catch(() => {}); throw e; } } }
}

module.exports = { Services, readGoogleClient };
