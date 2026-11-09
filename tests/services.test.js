"use strict";
const test = require("node:test");
const assert = require("node:assert");
const config = require("../src/config");
const { Services } = require("../src/services");
const { makeFake } = require("./fake-ragic");

const NOW = Date.now();
function googleStub(threads) {
  const sent = [];
  const f = async (url, opts) => {
    url = String(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 });
    if (url.includes("/threads?")) return new Response(JSON.stringify({ threads: threads.map((t) => ({ id: t.id })) }), { status: 200 });
    const m = url.match(/\/threads\/([^?]+)\?/);
    if (m) { const t = threads.find((x) => x.id === decodeURIComponent(m[1])); return new Response(JSON.stringify({ id: t.id, messages: t.messages }), { status: 200 }); }
    if (url.endsWith("/messages/send")) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ id: "sent1" }), { status: 200 }); }
    return fetch(url, opts);
  };
  f.sent = sent; return f;
}
const gm = (id, t, from, to, subject) => ({ id, internalDate: String(t), payload: { headers: [{ name: "From", value: from }, { name: "To", value: to }, { name: "Subject", value: subject }] } });

async function boot(threads = []) {
  const fake = await makeFake();
  const fetchImpl = googleStub(threads);
  const store = { google_refresh: "r", google_profile: JSON.stringify({ email: "agence@remithollet.fr", name: "Agence" }), me: "Dieu" };
  const vault = { get: (k) => store[k], set: (k, v) => { store[k] = v; } };
  const svc = new Services({ vault, googleClient: { clientId: "c", clientSecret: "s" }, fetchImpl, ragicProtocol: "http", openExternal() {}, connections: { ragic: { key: "KEY", host: fake.host, apname: "agoa" } } });
  await svc.startStore();
  assert.equal(svc.error, null, svc.error && svc.error.message);
  const seed = async (sheet, rec) => { const s = svc.store; await s.create(sheet, rec); };
  await seed("collaborateurs", { nom: "Dieu", email: "dieu@remithollet.fr", fonction: "Architecte", valideur: false, actif: true });
  await seed("collaborateurs", { nom: "Rémi", email: "remi@remithollet.fr", fonction: "Architecte", valideur: true, actif: true });
  await seed("collaborateurs", { nom: "Marie", email: "marie@remithollet.fr", fonction: "Comptabilité", valideur: false, actif: true });
  await seed("alias", { adresse: "comptabilite@remithollet.fr", collaborateur: "Marie" });
  await seed("regles", { phase: "Proposition d'honoraires", statutPhase: "Transmise", champ: "Date proposition", action: "Remplacer", valeur: "{date du jour}", actif: true });
  const o = config.ragic.operations;
  const opRid = await svc.store.client.create(o.path, { [o.code]: "DELTA14-A", [o.imm]: "DELTA14", [o.architecte]: "Charlotte", [o.statut]: "Actif" });
  await seed("collaborateurs", { nom: "Charlotte", email: "c@remithollet.fr", fonction: "Architecte", actif: true });
  const imm = config.ragic.immeubles; await svc.store.client.create(imm.path, { [svc.store.f.immeubles.code]: "DELTA14", [svc.store.f.immeubles.syndic]: "Foncia" });
  await svc.reload();
  return { fake, svc, fetchImpl, opRid };
}

test("synchro Gmail : crée le fil, rattache l'opération, attribue par alias", async () => {
  const { fake, svc } = await boot([{ id: "t1", messages: [gm("m1", NOW - 5000, "Foncia <x@foncia.fr>", "comptabilite@remithollet.fr", "Facture DELTA14-A")] }]);
  const r = await svc.syncGmail();
  assert.equal(r.updated, 1);
  const m = svc.data.mails[0];
  assert.equal(m.op, "DELTA14-A"); assert.equal(m.assigne, "Marie"); assert.equal(m.statut, "nouveau"); assert.ok(m.opRid > 0);
  assert.equal((await svc.syncGmail()).updated, 0);        // idempotent : pas de doublon
  assert.equal(fake.sheets[config.ragic.sheets.mails.path].recs.size, 1);
  await fake.close(); svc.stopStore();
});

test("envoi en attente puis réponse : « À traiter » et notification", async () => {
  const threads = [{ id: "t2", messages: [gm("m1", NOW - 9000, "x@foncia.fr", "agence@remithollet.fr", "Devis DELTA14-A")] }];
  const { fake, svc, fetchImpl } = await boot(threads);
  await svc.syncGmail();
  await svc.send("t2", { to: ["a@ent.fr"], bcc: ["b@ent.fr"], body: "Bonjour", mode: "attente" });
  assert.equal(fetchImpl.sent.length, 1);
  assert.equal(svc.data.mails[0].statut, "attente"); assert.equal(svc.data.mails[0].attendu.length, 2);
  threads[0].messages.push(gm("m2", NOW, "A <a@ent.fr>", "agence@remithollet.fr", "Re: Devis DELTA14-A"));
  threads[0].messages.splice(1, 0, gm("m1b", NOW - 4000, "agence@remithollet.fr", "a@ent.fr", "Devis DELTA14-A"));
  await svc.syncGmail();
  const m = svc.data.mails[0];
  assert.equal(m.statut, "atraiter");
  assert.ok(svc.data.notifications.some((n) => n.pour === "Charlotte" && /Réponse de/.test(n.texte)));
  await fake.close(); svc.stopStore();
});

test("transmission, note avec mention, validation", async () => {
  const { fake, svc } = await boot([{ id: "t3", messages: [gm("m1", NOW, "x@foncia.fr", "agence@remithollet.fr", "RDV DELTA14-A")] }]);
  await svc.syncGmail();
  await svc.transfer("t3", "Marie", "facturation");
  assert.equal(svc.data.mails[0].assigne, "Marie");
  assert.ok(svc.data.notifications.some((n) => n.pour === "Charlotte" && /prend en charge/.test(n.texte)));
  await svc.addNote("t3", "À voir avec @Rémi");
  assert.ok(svc.data.notifications.some((n) => n.pour === "Rémi" && /mentionné/.test(n.texte)));
  await svc.setStatut("t3", "avalider");
  assert.ok(svc.data.notifications.some((n) => n.pour === "Rémi" && /Validation demandée/.test(n.texte)));
  await fake.close(); svc.stopStore();
});

test("phase : règle appliquée si l'opération existe, information conservée sinon puis rattachée", async () => {
  const { fake, svc, opRid } = await boot([
    { id: "t4", messages: [gm("m1", NOW, "x@foncia.fr", "agence@remithollet.fr", "Propale DELTA14-A")] },
    { id: "t5", messages: [gm("m2", NOW, "x@foncia.fr", "agence@remithollet.fr", "Propale DELTA14")] }
  ]);
  await svc.syncGmail();
  const a = await svc.setPhaseStatus("t4", "Proposition d'honoraires", "Transmise");
  assert.equal(a.applied, 1);
  assert.match(String(fake.sheets[config.ragic.operations.path].recs.get(opRid)[1000282]), /^\d{4}\/\d{2}\/\d{2}$/);
  assert.equal(svc.data.avancement.length, 1);
  // opération inexistante : on garde l'info, puis on la rattache à la création
  await svc.link("t5", { imm: "DELTA14", op: "DELTA14-B" });
  await svc.setPhaseStatus("t5", "Proposition d'honoraires", "Transmise");
  const pending = svc.data.avancement.find((x) => x.codeOp === "DELTA14-B");
  assert.ok(pending && !pending.opRid);
  const o = config.ragic.operations;
  const rid2 = await svc.store.client.create(o.path, { [o.code]: "DELTA14-B", [o.imm]: "DELTA14", [o.statut]: "Actif" });
  await svc.reload();
  assert.equal(await svc.reconcileAvancement(), 1);
  assert.match(String(fake.sheets[o.path].recs.get(rid2)[1000282]), /^\d{4}\//);
  await fake.close(); svc.stopStore();
});

test("compte commun : « qui suis-je » retenu, actions refusées sans choix, jeton du lanceur repris", async () => {
  const { fake, svc } = await boot([]);
  assert.equal(svc.state().collaborateur.nom, "Dieu");
  assert.throws(() => svc.setMe("Inconnu"), /inconnu/i);
  svc.vault.set("me", "");
  await assert.rejects(svc.setStatut("x", "traite"), (e) => e.code === "no_actor");
  svc.setMe("Rémi"); assert.equal(svc.who(), "Rémi");
  const store = {}; const v = { get: (k) => store[k], set: (k, x) => { store[k] = x; } };
  const s2 = new Services({ vault: v, googleClient: { clientId: "c", clientSecret: "s" }, fetchImpl: fetch, openExternal() {}, connections: { ragic: { key: "k" }, google: { refresh_token: "RT", email: "agence@remithollet.fr", client_id: "c" } } });
  assert.equal(s2.auth.signedIn(), true);
  const store3 = {}; const v3 = { get: (k) => store3[k], set: (k, x) => { store3[k] = x; } };
  const s3 = new Services({ vault: v3, googleClient: { clientId: "c", clientSecret: "s" }, fetchImpl: fetch, openExternal() {}, connections: { ragic: { key: "k" }, google: { refresh_token: "RT", email: "agence@remithollet.fr", client_id: "c", scopes: "https://www.googleapis.com/auth/gmail.send" } } });
  assert.equal(s3.auth.signedIn(), false, "un jeton limité à l’envoi n’est pas repris");
  await fake.close(); svc.stopStore();
});

test("kanban : nouveau fil en « To do », déplacement, archivage puis réponse = retour dans la colonne", async () => {
  const threads = [{ id: "k1", messages: [gm("m1", NOW - 9000, "x@foncia.fr", "agence@remithollet.fr", "Chantier DELTA14-A")] }];
  const { fake, svc } = await boot(threads);
  await svc.store.create("colonnes", { ordre: 1, libelle: "To do", couleur: "Gris", actif: true, defaut: true });
  await svc.store.create("colonnes", { ordre: 2, libelle: "Chantier", couleur: "Bleu", actif: true, defaut: false });
  await svc.reload();
  assert.equal(svc.state().kanban, true);
  await svc.syncGmail();
  assert.equal(svc.data.mails[0].colonne, "To do");
  await svc.setColonne("k1", "Chantier");
  assert.equal(svc.data.mails[0].colonne, "Chantier");
  await svc.setStatut("k1", "traite");                       // archivé : la colonne est conservée
  assert.equal(svc.data.mails[0].colonne, "Chantier");
  threads[0].messages.push(gm("m2", NOW, "x@foncia.fr", "agence@remithollet.fr", "Re: Chantier DELTA14-A"));
  await svc.syncGmail();
  const m = svc.data.mails[0];
  assert.equal(m.statut, "atraiter"); assert.equal(m.colonne, "Chantier");
  assert.ok(m.journal.some((j) => /remis dans la colonne « Chantier »/.test(j.texte)));
  await assert.rejects(svc.setColonne("k1", "Inconnue"), (e) => e.code === "not_found");
  await fake.close(); svc.stopStore();
});

test("kanban : supprimer une colonne renvoie ses fils dans la colonne par défaut ; la colonne par défaut est protégée", async () => {
  const { fake, svc } = await boot([{ id: "k2", messages: [gm("m1", NOW, "x@foncia.fr", "agence@remithollet.fr", "RDV DELTA14-A")] }]);
  await svc.store.create("colonnes", { ordre: 1, libelle: "To do", couleur: "Gris", actif: true, defaut: true });
  await svc.store.create("colonnes", { ordre: 2, libelle: "AO", couleur: "Violet", actif: true, defaut: false });
  await svc.reload(); await svc.syncGmail();
  await svc.setColonne("k2", "AO");
  await assert.rejects(svc.removeRecord("colonnes", "To do"), (e) => e.code === "forbidden");
  await svc.removeRecord("colonnes", "AO");
  assert.equal(svc.data.mails[0].colonne, "To do");
  await svc.saveRecord("colonnes", { libelle: "Étude", couleur: "Bleu", ordre: 2, actif: true, defaut: false });
  await svc.saveRecord("colonnes", { libelle: "Étude 2", _renameFrom: "Étude", couleur: "Bleu", ordre: 2, actif: true, defaut: false });
  assert.deepEqual(svc.data.colonnes.map((c) => c.libelle), ["To do", "Étude 2"]);
  await fake.close(); svc.stopStore();
});

test("kanban : sans la feuille Colonnes, l'application fonctionne avec « To do » seul et refuse les déplacements", async () => {
  const fake = await makeFake();
  delete fake.sheets[config.ragic.sheets.colonnes.path]; delete fake.schema[config.ragic.sheets.colonnes.path];
  const store = { google_refresh: "r", google_profile: JSON.stringify({ email: "agence@remithollet.fr", name: "A" }), me: "Dieu" };
  const svc = new Services({ vault: { get: (k) => store[k], set: (k, v) => { store[k] = v; } }, googleClient: { clientId: "c", clientSecret: "s" }, fetchImpl: googleStub([]), ragicProtocol: "http", openExternal() {}, connections: { ragic: { key: "KEY", host: fake.host, apname: "agoa" } } });
  await svc.startStore();
  assert.equal(svc.error, null, svc.error && svc.error.message);
  await svc.store.create("collaborateurs", { nom: "Dieu", actif: true }); await svc.reload();
  assert.equal(svc.state().kanban, false); assert.deepEqual(svc.data.colonnes.map((c) => c.libelle), ["To do"]);
  await assert.rejects(svc.setColonne("x", "To do"), (e) => e.code === "no_kanban");
  await fake.close(); svc.stopStore();
});
