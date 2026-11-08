"use strict";
/* Règles métier de AGOA ML (boîte mail partagée) : fonctions pures, sans Ragic ni Gmail.
   Chaque fonction qui change un fil renvoie { mail, journal, notifs } : le journal et les notifications à enregistrer.
   Modèle d'un fil (mail) :
   { id (Thread ID Gmail), objet, expediteur, expEmail, alias, imm, op (code complet « DELTA14-A » ou ""), opRid,
     phase, statut, assigne (nom du collaborateur ou ""), relance (ISO ou ""), attenteDepuis (ISO ou ""),
     nb, dernier (ISO), dernierExp, lien, notes[], journal[], attendu[], rapproches[] } */

const STATUTS = [
  { id: "nouveau", label: "Nouveau" },
  { id: "atraiter", label: "À traiter" },
  { id: "attente", label: "En attente" },
  { id: "avalider", label: "À valider" },
  { id: "traite", label: "Traité" }
];
const STATUT_LABEL = Object.fromEntries(STATUTS.map((s) => [s.id, s.label]));

const norm = (s) => String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’‘`]/g, "'").trim().toLowerCase();
const short = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const lc = (s) => String(s || "").trim().toLowerCase();

/* ---------- codes ---------- */
/** Sépare un code opération « DELTA14-A » en { imm, indice } selon la liste des codes immeuble (le plus long d'abord). */
function splitOpCode(code, immCodes) {
  const c = String(code || "").trim();
  const sorted = [...immCodes].sort((a, b) => b.length - a.length);
  for (const imm of sorted) {
    if (c.toUpperCase().startsWith(imm.toUpperCase() + "-")) return { imm, indice: c.slice(imm.length + 1) };
  }
  return null;
}
const INDICE_RE = /^[A-Z][A-Z0-9]{0,2}$/;

/** Cherche le rattachement d'un fil : opération (code complet) > immeuble > syndic/adresse de l'expéditeur.
    ctx : { immeubles:[{code, syndic, emails[]}], operations:[{code, imm, archi}], syndics:[{nom, emails[]}] } */
function detect(mail, ctx) {
  const subject = String(mail.objet || "").toUpperCase();
  const ops = [...ctx.operations].sort((a, b) => b.code.length - a.code.length);
  for (const o of ops) {
    if (subject.includes(o.code.toUpperCase())) return { imm: o.imm, op: o.code, confidence: "haute", why: `Le code ${o.code} figure dans l’objet du message.` };
  }
  const imms = [...ctx.immeubles].sort((a, b) => b.code.length - a.code.length);
  for (const i of imms) {
    if (subject.includes(i.code.toUpperCase())) return { imm: i.code, op: "", confidence: "haute", why: `Le code immeuble ${i.code} figure dans l’objet. Choisissez l’opération si elle existe.` };
  }
  const email = lc(mail.expEmail);
  if (email) {
    const byMail = ctx.immeubles.filter((i) => (i.emails || []).some((e) => lc(e) === email));
    if (byMail.length === 1) return { imm: byMail[0].code, op: "", confidence: "moyenne", why: `${email} est le contact de l’immeuble ${byMail[0].code}. Vérifiez.` };
    const syn = (ctx.syndics || []).find((s) => (s.emails || []).some((e) => lc(e) === email));
    if (syn) {
      const bySyn = ctx.immeubles.filter((i) => norm(i.syndic) === norm(syn.nom));
      if (bySyn.length === 1) return { imm: bySyn[0].code, op: "", confidence: "faible", why: `${syn.nom} est le syndic de l’immeuble ${bySyn[0].code}. Vérifiez.` };
    }
  }
  return null;
}

/* ---------- responsable effectif ---------- */
const archiOf = (mail, ops) => { const o = mail.op && ops.find((x) => x.code === mail.op); return o ? o.archi || "" : ""; };
const handler = (mail, ops) => mail.assigne || archiOf(mail, ops);

/* ---------- effets (journal + notifications) ---------- */
const evt = (by, texte, now) => ({ t: now, par: by || "Automatique", texte });
const notif = (pour, de, texte, thread, now) => ({ pour, de, t: now, texte, thread, lue: false });

/** Notification à `pour` seulement si c'est quelqu'un d'autre que l'auteur (ou si force). */
function maybeNotif(list, pour, by, texte, thread, now, force) {
  if (!pour || (pour === by && !force)) return;
  list.push(notif(pour, by, texte, thread, now));
}

function transfer(mail, to, { by, motif, ops, now }) {
  const prev = handler(mail, ops), ar = archiOf(mail, ops);
  const m = { ...mail, assigne: to || "" };
  if (to && m.statut === "nouveau") m.statut = "atraiter";
  const h = handler(m, ops);
  const journal = [evt(by, to ? `a transmis le fil à ${to}${motif ? " (" + motif + ")" : ""}` : `a rendu le fil${ar ? " à l’architecte " + ar : " sans responsable"}`, now)];
  const notifs = [];
  if (h !== prev) maybeNotif(notifs, h, by, `${by} vous a transmis « ${short(m.objet, 60)} »${motif ? " : " + motif : ""}`, m.id, now);
  if (to && ar && ar !== h) maybeNotif(notifs, ar, by, `${to} prend en charge « ${short(m.objet, 50)} » sur ${m.op || m.imm}${motif ? " (" + motif + ")" : ""}, transmis par ${by}`, m.id, now);
  return { mail: m, journal, notifs };
}

/** valideurs : noms des collaborateurs qui valident. */
function setStatut(mail, statut, { by, ops, valideurs = [], now }) {
  const m = { ...mail, statut };
  const label = STATUT_LABEL[statut] || statut;
  const journal = [evt(by, `a passé le statut à « ${label} »`, now)];
  const notifs = [];
  if (statut === "attente" && !m.attenteDepuis) m.attenteDepuis = new Date(now).toISOString();
  if (statut !== "attente") m.attenteDepuis = "";
  if (statut === "avalider") valideurs.forEach((v) => maybeNotif(notifs, v, by, `Validation demandée par ${by} : « ${short(m.objet, 70)} »`, m.id, now));
  const h = handler(m, ops);
  if (!(statut === "avalider" && valideurs.includes(h))) maybeNotif(notifs, h, by, `${by} a passé « ${short(m.objet, 60)} » à « ${label} »`, m.id, now);
  return { mail: m, journal, notifs };
}

/* ---------- envoi et réponses attendues ---------- */
/** Après un envoi. mode "attente" : le fil passe « En attente » (après validation) avec la liste des réponses attendues.
    destinataires : [{ email, nom }] (À + Cci). */
function afterSend(mail, { destinataires, mode, by, ops, now, nbCci = 0 }) {
  const m = { ...mail, nb: (mail.nb || 0) + 1, dernier: new Date(now).toISOString(), dernierExp: by };
  const n = destinataires.length;
  const journal = [evt(by, `a envoyé un message à ${n} destinataire${n > 1 ? "s" : ""}${nbCci ? ` (dont ${nbCci} en Cci)` : ""}`, now)];
  if (mode === "attente") {
    const known = m.attendu || [];
    m.attendu = destinataires.map((d) => { const k = known.find((x) => lc(x.email) === lc(d.email)); return { email: lc(d.email), nom: d.nom || k && k.nom || "", recu: k ? !!k.recu : false }; });
    m.statut = "attente"; m.attenteDepuis = new Date(now).toISOString();
    journal.push(evt(by, `a passé le statut à « En attente » (0/${n} réponses)`, now));
  }
  return { mail: m, journal, notifs: [] };
}

const recus = (m) => (m.attendu || []).filter((d) => d.recu).length;

/** Un message entrant. separate = arrivé dans un autre fil que celui d'origine (rapprochement). */
function onIncoming(mail, incoming, { ops, now, separate = false, srcThread = "" }) {
  const m = { ...mail, nb: (mail.nb || 0) + 1, dernier: new Date(now).toISOString(), dernierExp: incoming.nom || incoming.email };
  const d = (m.attendu || []).find((x) => lc(x.email) === lc(incoming.email));
  if (d && !d.recu) m.attendu = m.attendu.map((x) => (x === d ? { ...x, recu: true, date: new Date(now).toISOString() } : x));
  const total = (m.attendu || []).length;
  const reopen = m.statut === "attente" || m.statut === "traite";
  if (reopen) { m.statut = "atraiter"; m.attenteDepuis = ""; }
  if (separate && srcThread) m.rapproches = [...(m.rapproches || []), { thread: srcThread, objet: incoming.objet || "", exp: incoming.email, date: new Date(now).toISOString() }];
  const who = incoming.nom || incoming.email;
  const compteur = total ? ` (${recus(m)}/${total})` : "";
  const journal = [evt("", `${separate ? "mail séparé de " + who + " rapproché du fil (destinataire attendu)" : "réponse de " + who + " reçue"}${compteur}${reopen ? ", fil repassé à « À traiter »" : ""}`, now)];
  if (total && recus(m) === total) journal.push(evt("", "toutes les réponses attendues sont arrivées", now));
  const notifs = [];
  maybeNotif(notifs, handler(m, ops), "", `Réponse de ${who} sur « ${short(m.objet, 60)} »${compteur}${separate ? ", mail séparé rapproché" : ""}`, m.id, now, true);
  return { mail: m, journal, notifs };
}

/** Fil en attente dont un destinataire attendu (pas encore reçu) correspond à cet expéditeur. */
function findWaiting(mails, email, excludeId) {
  return mails.find((x) => x.id !== excludeId && x.statut === "attente" && (x.attendu || []).some((d) => lc(d.email) === lc(email) && !d.recu)) || null;
}

/* ---------- règles de synchronisation vers OPERATIONS ---------- */
/** rules : [{ phase, statutPhase, champ (libellé), action ("Remplacer"|"Ajouter à la liste"|"Retirer de la liste"), valeur, actif }].
    Renvoie les modifications à appliquer : [{ champ, action, valeur }] avec {date du jour} et {utilisateur} remplacés. */
function applyRules(rules, phase, statutPhase, { today, user }) {
  const date = String(today).slice(0, 10).replace(/-/g, "/");
  return rules.filter((r) => r.actif !== false && norm(r.phase) === norm(phase) && norm(r.statutPhase) === norm(statutPhase))
    .map((r) => ({ champ: r.champ, action: r.action || "Remplacer", valeur: String(r.valeur || "").replace(/\{date du jour\}/gi, date).replace(/\{utilisateur\}/gi, user || "") }));
}

module.exports = { STATUTS, STATUT_LABEL, INDICE_RE, norm, short, splitOpCode, detect, archiOf, handler, transfer, setStatut, afterSend, onIncoming, findWaiting, recus, applyRules };
