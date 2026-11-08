"use strict";
const test = require("node:test");
const assert = require("node:assert");
const config = require("../src/config");
const { RagicClient } = require("../src/ragic");
const { MailStore } = require("../src/store");
const { makeFake } = require("./fake-ragic");

async function setup(opts) {
  const fake = await makeFake(opts);
  const client = new RagicClient({ host: fake.host, apname: "agoa", apiKey: "KEY", protocol: "http" });
  const store = new MailStore({ client, config });
  return { fake, client, store };
}

test("resolveFields : retrouve les champs par libellé", async () => {
  const { fake, store } = await setup();
  await store.resolveFields();
  assert.ok(store.f.mails.id && store.f.mails.journal && store.f.avancement.codeOp);
  await fake.close();
});

test("resolveFields : signale les champs absents", async () => {
  const { fake, store } = await setup();
  fake.schema[config.ragic.sheets.mails.path] = fake.schema[config.ragic.sheets.mails.path].filter((f) => f.fieldName !== "Journal");
  await assert.rejects(store.resolveFields(), (e) => e.code === "missing_field" && /« Journal »/.test(e.message));
  await fake.close();
});

test("upsert d'un fil : création puis mise à jour, JSON et dates conservés", async () => {
  const { fake, store } = await setup();
  await store.resolveFields();
  const mail = { id: "t1", objet: "Devis", statut: "attente", nb: 2, op: "DELTA14-A", opRid: 0, attendu: [{ email: "a@e.fr", nom: "A", recu: false }], journal: [{ t: 1, par: "Dieu", texte: "x" }], attenteDepuis: "2026-11-09T09:00:00.000Z" };
  const rid = await store.upsert("mails", mail);
  assert.equal(fake.sheets[config.ragic.sheets.mails.path].recs.size, 1);
  const rid2 = await store.upsert("mails", { ...mail, statut: "atraiter" });
  assert.equal(rid, rid2); assert.equal(fake.sheets[config.ragic.sheets.mails.path].recs.size, 1);
  const docs = await store.all("mails");
  assert.equal(docs[0].statut, "atraiter"); assert.deepEqual(docs[0].attendu, mail.attendu); assert.equal(docs[0].nb, 2);
  assert.equal(new Date(docs[0].attenteDepuis).getTime(), new Date(mail.attenteDepuis).getTime());
  await fake.close();
});

test("updateOperation : remplace et ajoute à la liste ; signale les champs inconnus", async () => {
  const { fake, client, store } = await setup();
  await store.resolveFields();
  const o = config.ragic.operations;
  const rid = await client.create(o.path, { [o.code]: "DELTA14-A", [o.avancement]: "Chiffrage" });
  const r = await store.updateOperation(rid, [
    { champ: "Date proposition", action: "Remplacer", valeur: "2026/11/09" },
    { champ: "Avancement", action: "Ajouter à la liste", valeur: "PROPALE" },
    { champ: "Champ fantôme", action: "Remplacer", valeur: "x" }
  ]);
  const rec = fake.sheets[o.path].recs.get(rid);
  assert.equal(rec[1000282], "2026/11/09"); assert.equal(rec[o.avancement], "Chiffrage,PROPALE");
  assert.deepEqual(r.unknown, ["Champ fantôme"]);
  await fake.close();
});

test("operations : lit code, immeuble et architecte", async () => {
  const { fake, client, store } = await setup();
  await store.resolveFields();
  const o = config.ragic.operations;
  await client.create(o.path, { [o.code]: "DIDOT30-B2", [o.imm]: "DIDOT30", [o.architecte]: "Frédéric", [o.statut]: "Actif" });
  const ops = await store.operations({ onlyActive: true });
  assert.deepEqual(ops.map((x) => [x.code, x.archi]), [["DIDOT30-B2", "Frédéric"]]);
  await fake.close();
});
