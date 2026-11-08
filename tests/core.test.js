"use strict";
const test = require("node:test");
const assert = require("node:assert");
const C = require("../src/core");

const ctx = {
  immeubles: [
    { code: "BANQUIER33", syndic: "Europe Sèvres", emails: ["g@ies.fr"] },
    { code: "BANQUIER33-33bis", syndic: "Europe Sèvres", emails: [] },
    { code: "DELTA14", syndic: "Foncia", emails: [] },
    { code: "DIDOT30", syndic: "Michau", emails: [] }
  ],
  operations: [
    { code: "BANQUIER33-A", imm: "BANQUIER33", archi: "Thomas" },
    { code: "BANQUIER33-33bis-A", imm: "BANQUIER33-33bis", archi: "Rémi" },
    { code: "DELTA14-A", imm: "DELTA14", archi: "Charlotte" },
    { code: "DIDOT30-B2", imm: "DIDOT30", archi: "Frédéric" }
  ],
  syndics: [{ nom: "Foncia", emails: ["contact@foncia.fr"] }]
};
const ops = ctx.operations;
const NOW = Date.UTC(2026, 10, 9, 10, 0, 0);

test("splitOpCode : codes composés et indices à plusieurs caractères", () => {
  const codes = ctx.immeubles.map((i) => i.code);
  assert.deepEqual(C.splitOpCode("BANQUIER33-33bis-A", codes), { imm: "BANQUIER33-33bis", indice: "A" });
  assert.deepEqual(C.splitOpCode("DIDOT30-B2", codes), { imm: "DIDOT30", indice: "B2" });
  assert.equal(C.splitOpCode("INCONNU-A", codes), null);
});

test("detect : le code le plus long l'emporte", () => {
  assert.equal(C.detect({ objet: "Devis BANQUIER33-33bis-A" }, ctx).op, "BANQUIER33-33bis-A");
  assert.equal(C.detect({ objet: "Devis BANQUIER33-A" }, ctx).imm, "BANQUIER33");
  const imm = C.detect({ objet: "Fissures BANQUIER33-33bis" }, ctx);
  assert.equal(imm.imm, "BANQUIER33-33bis"); assert.equal(imm.op, "");
  const d = C.detect({ objet: "DIDOT30-B2 : RDV" }, ctx); assert.equal(d.op, "DIDOT30-B2");
});

test("detect : repli sur l'expéditeur (immeuble puis syndic)", () => {
  assert.equal(C.detect({ objet: "Bonjour", expEmail: "G@ies.fr" }, ctx).imm, "BANQUIER33");
  assert.equal(C.detect({ objet: "Bonjour", expEmail: "contact@foncia.fr" }, ctx).imm, "DELTA14");
  assert.equal(C.detect({ objet: "Bonjour", expEmail: "x@y.fr" }, ctx), null);
});

test("handler : le fil suit l'architecte, sauf transmission", () => {
  const m = { id: "t1", objet: "x", op: "DELTA14-A", assigne: "", statut: "nouveau" };
  assert.equal(C.handler(m, ops), "Charlotte");
  const r = C.transfer(m, "Delphine", { by: "Dieu", motif: "RDV", ops, now: NOW });
  assert.equal(r.mail.assigne, "Delphine"); assert.equal(r.mail.statut, "atraiter");
  assert.deepEqual(r.notifs.map((n) => n.pour).sort(), ["Charlotte", "Delphine"]);
  const back = C.transfer(r.mail, "", { by: "Dieu", ops, now: NOW });
  assert.equal(C.handler(back.mail, ops), "Charlotte");
});

test("setStatut : à valider notifie les valideurs, pas l'auteur", () => {
  const m = { id: "t1", objet: "Propale", op: "DELTA14-A", assigne: "", statut: "atraiter" };
  const r = C.setStatut(m, "avalider", { by: "Charlotte", ops, valideurs: ["Rémi"], now: NOW });
  assert.deepEqual(r.notifs.map((n) => n.pour), ["Rémi"]);
});

test("envoi en attente puis réponse dans le fil : retour à « À traiter »", () => {
  let m = { id: "t13", objet: "Devis", op: "BANQUIER33-A", assigne: "", statut: "atraiter", notes: [], journal: [] };
  m = C.afterSend(m, { destinataires: [{ email: "A@e.fr", nom: "A" }, { email: "b@e.fr", nom: "B" }, { email: "c@e.fr", nom: "C" }], mode: "attente", by: "Dieu", ops, now: NOW, nbCci: 3 }).mail;
  assert.equal(m.statut, "attente"); assert.equal(m.attendu.length, 3); assert.ok(m.attenteDepuis);
  const r = C.onIncoming(m, { email: "a@e.fr", nom: "A" }, { ops, now: NOW + 1000 });
  assert.equal(r.mail.statut, "atraiter"); assert.equal(C.recus(r.mail), 1);
  assert.equal(r.notifs[0].pour, "Thomas");
});

test("mail séparé rapproché du fil en attente", () => {
  let m = { id: "t13", objet: "Devis", op: "BANQUIER33-A", statut: "attente", attendu: [{ email: "b@e.fr", nom: "B", recu: false }] };
  const w = C.findWaiting([m], "B@e.fr", "t99");
  assert.equal(w.id, "t13");
  const r = C.onIncoming(m, { email: "b@e.fr", nom: "B", objet: "Notre offre" }, { ops, now: NOW, separate: true, srcThread: "t99" });
  assert.equal(r.mail.rapproches[0].thread, "t99");
  assert.ok(r.journal.some((j) => /toutes les réponses/.test(j.texte)));
  assert.equal(C.findWaiting([r.mail], "b@e.fr", "t99"), null);
});

test("applyRules : phase + statut -> champs OPERATIONS", () => {
  const rules = [
    { phase: "Proposition d'honoraires", statutPhase: "Transmise", champ: "Date proposition", action: "Remplacer", valeur: "{date du jour}", actif: true },
    { phase: "Proposition d’honoraires", statutPhase: "Validée", champ: "Propo validée", valeur: "Yes" },
    { phase: "Rapport", statutPhase: "Transmise", champ: "Date rapport", valeur: "{date du jour}", actif: false }
  ];
  const out = C.applyRules(rules, "Proposition d’honoraires", "transmise", { today: "2026-11-09", user: "Dieu" });
  assert.deepEqual(out, [{ champ: "Date proposition", action: "Remplacer", valeur: "2026/11/09" }]);
  assert.equal(C.applyRules(rules, "Rapport", "Transmise", { today: "2026-11-09" }).length, 0);
});
