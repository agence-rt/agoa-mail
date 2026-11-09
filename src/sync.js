"use strict";
/* Synchronisation Gmail -> Ragic : transforme les fils Gmail en fiches « Mails », rapproche les mails séparés
   des fils « En attente » et produit journal + notifications. planSync est pur (testable sans réseau). */
const C = require("./core");

const lc = (s) => String(s || "").trim().toLowerCase();
const iso = (t) => new Date(t).toISOString();

/** state : { mails[], ops[], immeubles[], syndics[], aliases[{adresse, collaborateur}], agencyEmails:Set|[], now }
    threads : fils Gmail normalisés. Retourne { upserts: Map(id -> mail), notifs[], skipped[] }. */
function planSync(threads, state) {
  const agency = new Set([...(state.agencyEmails || [])].map(lc));
  const isAgency = (email) => agency.has(lc(email)) || /@remithollet\.fr$/i.test(email);
  const byId = new Map(state.mails.map((m) => [m.id, { ...m }]));
  const merged = new Set(state.mails.flatMap((m) => (m.rapproches || []).map((r) => r.thread)));
  const ctx = { immeubles: state.immeubles, operations: state.ops, syndics: state.syndics };
  const aliasMap = new Map((state.aliases || []).map((a) => [lc(a.adresse), a.collaborateur]));
  const upserts = new Map(), notifs = [], skipped = [];
  const touch = (m, r) => { byId.set(m.id, m); upserts.set(m.id, m); m.journal = [...(m.journal || []), ...r.journal]; notifs.push(...r.notifs); };

  for (const th of [...threads].sort((a, b) => ((a.messages[0] || {}).t || 0) - ((b.messages[0] || {}).t || 0))) {
    if (!th.messages.length || merged.has(th.id)) { skipped.push(th.id); continue; }
    let mail = byId.get(th.id);
    const first = th.messages[0];

    if (!mail) {
      const ext = th.messages.find((m) => !isAgency(m.from.email));
      const toAddr = new Set(th.messages.flatMap((m) => m.to.map((x) => lc(x.email))));
      const alias = (state.aliasList || []).find((a) => toAddr.has(lc(a))) || "";
      const det = C.detect({ objet: th.objet, expEmail: ext ? ext.from.email : "" }, ctx);
      const op = det && det.op ? state.ops.find((o) => o.code === det.op) : null;
      const incoming = th.messages.filter((m) => !isAgency(m.from.email));
      /* mail séparé d'un destinataire attendu : on le rapproche au lieu de créer un fil */
      if (incoming.length === 1 && th.messages.length === 1) {
        const w = C.findWaiting([...byId.values()], incoming[0].from.email, th.id);
        if (w) {
          const r = C.onIncoming(w, { email: incoming[0].from.email, nom: incoming[0].from.nom, objet: th.objet }, { ops: state.ops, now: incoming[0].t, separate: true, srcThread: th.id });
          touch(r.mail, r); merged.add(th.id); continue;
        }
      }
      mail = {
        id: th.id, objet: th.objet, expediteur: ext ? (ext.from.nom || ext.from.email) : "", expEmail: ext ? ext.from.email : "",
        alias, imm: det ? det.imm : "", op: det && det.op ? det.op : "", opRid: op ? op.rid : 0, phase: "",
        colonne: state.defaultCol || "", statut: "nouveau", assigne: alias && aliasMap.get(lc(alias)) ? aliasMap.get(lc(alias)) : "", relance: "", attenteDepuis: "",
        nb: th.messages.length, dernier: iso(th.messages[th.messages.length - 1].t), dernierExp: th.messages[th.messages.length - 1].from.nom || th.messages[th.messages.length - 1].from.email,
        lien: `https://mail.google.com/mail/u/0/#all/${th.id}`, notes: [], journal: [], attendu: [], rapproches: []
      };
      mail.journal = [{ t: state.now, par: "Automatique", texte: "fil reçu" + (det ? ` ; rattaché à ${det.op || det.imm} (${det.why})` : "") + (mail.assigne ? `, attribué à ${mail.assigne} (alias ${alias})` : "") }];
      byId.set(mail.id, mail); upserts.set(mail.id, mail);
      if (det) mail.detection = det.confidence;
      continue;
    }

    /* fil connu : nouveaux messages depuis la dernière synchronisation */
    const fresh = th.messages.slice(mail.nb || 0);
    if (!fresh.length) continue;
    let cur = mail;
    for (const msg of fresh) {
      if (isAgency(msg.from.email)) {
        cur = { ...cur, nb: (cur.nb || 0) + 1, dernier: iso(msg.t), dernierExp: msg.from.nom || msg.from.email };
        continue;
      }
      const r = C.onIncoming(cur, { email: msg.from.email, nom: msg.from.nom, objet: msg.objet }, { ops: state.ops, now: msg.t });
      cur = r.mail; cur.journal = [...(cur.journal || []), ...r.journal]; notifs.push(...r.notifs);
    }
    byId.set(cur.id, cur); upserts.set(cur.id, cur);
  }
  const names = new Set(state.colNames || []);
  upserts.forEach((m) => { delete m.detection; if (state.defaultCol && (!m.colonne || (names.size && !names.has(m.colonne)))) m.colonne = state.defaultCol; });
  return { upserts, notifs, skipped };
}

module.exports = { planSync };
