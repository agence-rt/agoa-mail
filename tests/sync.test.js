"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { planSync } = require("../src/sync");
const { parseAddresses, normalizeThread } = require("../src/gmail");

const NOW = Date.UTC(2026, 10, 9, 10);
const base = () => ({
  mails: [], ops: [{ rid: 77, code: "DELTA14-A", imm: "DELTA14", archi: "Charlotte" }, { rid: 78, code: "BANQUIER33-A", imm: "BANQUIER33", archi: "Thomas" }],
  immeubles: [{ code: "DELTA14", syndic: "Foncia", emails: [] }, { code: "BANQUIER33", syndic: "IES", emails: [] }], syndics: [],
  aliases: [{ adresse: "comptabilite@remithollet.fr", collaborateur: "Marie" }], aliasList: ["etudes@remithollet.fr", "comptabilite@remithollet.fr", "secretariat@remithollet.fr"],
  agencyEmails: ["agence@remithollet.fr"], now: NOW
});
const msg = (id, t, from, to, objet = "S") => ({ id, t, from: { nom: from.split("@")[0], email: from }, to: to.map((e) => ({ nom: "", email: e })), cc: [], objet });

test("nouveau fil : rattachement, opération Ragic, attribution par alias", () => {
  const th = { id: "t1", objet: "Facture DELTA14-A", messages: [msg("m1", NOW - 5000, "x@foncia.fr", ["comptabilite@remithollet.fr"], "Facture DELTA14-A")] };
  const { upserts } = planSync([th], base());
  const m = upserts.get("t1");
  assert.equal(m.op, "DELTA14-A"); assert.equal(m.opRid, 77); assert.equal(m.assigne, "Marie"); assert.equal(m.alias, "comptabilite@remithollet.fr"); assert.equal(m.statut, "nouveau");
});

test("réponse dans le fil en attente : repasse à « À traiter » et notifie l'architecte", () => {
  const st = base();
  st.mails = [{ id: "t13", objet: "Devis BANQUIER33-A", op: "BANQUIER33-A", statut: "attente", nb: 1, assigne: "", attendu: [{ email: "a@ent.fr", nom: "A", recu: false }], journal: [], rapproches: [] }];
  const th = { id: "t13", objet: "Devis BANQUIER33-A", messages: [msg("m1", NOW - 9000, "agence@remithollet.fr", ["a@ent.fr"]), msg("m2", NOW - 1000, "a@ent.fr", ["agence@remithollet.fr"])] };
  const { upserts, notifs } = planSync([th], st);
  const m = upserts.get("t13");
  assert.equal(m.statut, "atraiter"); assert.equal(m.nb, 2); assert.equal(m.attendu[0].recu, true);
  assert.equal(notifs[0].pour, "Thomas");
});

test("mail séparé d'un destinataire attendu : rapproché, pas de nouveau fil, pas de doublon à la synchro suivante", () => {
  const st = base();
  st.mails = [{ id: "t13", objet: "Devis", op: "BANQUIER33-A", statut: "attente", nb: 1, attendu: [{ email: "b@ent.fr", nom: "B", recu: false }], journal: [], rapproches: [] }];
  const sep = { id: "t99", objet: "Notre offre", messages: [msg("m9", NOW - 500, "b@ent.fr", ["agence@remithollet.fr"], "Notre offre")] };
  const r1 = planSync([sep], st);
  assert.equal(r1.upserts.has("t99"), false);
  const m = r1.upserts.get("t13");
  assert.equal(m.statut, "atraiter"); assert.equal(m.rapproches[0].thread, "t99");
  st.mails = [m];
  const r2 = planSync([sep], st);
  assert.equal(r2.upserts.size, 0); assert.deepEqual(r2.skipped, ["t99"]);
});

test("gmail : adresses et mots encodés", () => {
  assert.deepEqual(parseAddresses('"Dupont, Jean" <J.Dupont@x.fr>, b@y.fr'), [{ nom: "Dupont, Jean", email: "j.dupont@x.fr" }, { nom: "", email: "b@y.fr" }]);
  const n = normalizeThread({ id: "t", messages: [{ id: "m", internalDate: "5", payload: { headers: [{ name: "From", value: "A <a@b.fr>" }, { name: "Subject", value: "=?UTF-8?B?w4l0w6k=?=" }, { name: "To", value: "agence@remithollet.fr" }] } }] });
  assert.equal(n.objet, "Été"); assert.equal(n.messages[0].from.email, "a@b.fr");
});
