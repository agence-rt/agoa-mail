"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const NOW = Date.now();
const data = () => ({
  mails: [
    { id: "t1", objet: "Devis BANQUIER33-A", expediteur: "Entreprise A", expEmail: "a@e.fr", alias: "", imm: "BANQUIER33", op: "BANQUIER33-A", statut: "attente", assigne: "", nb: 2, dernier: new Date(NOW - 3600e3).toISOString(), attendu: [{ email: "a@e.fr", nom: "A", recu: false }, { email: "b@e.fr", nom: "B", recu: true }], notes: [], journal: [{ t: NOW, par: "Dieu", texte: "a envoyé" }], lien: "https://x" },
    { id: "t2", objet: "Facture", expediteur: "Foncia", expEmail: "f@foncia.fr", imm: "DELTA14", op: "", statut: "nouveau", assigne: "Marie", nb: 1, dernier: new Date(NOW - 7200e3).toISOString(), attendu: [], notes: [], journal: [] },
    { id: "t3", objet: "Sans dossier", expediteur: "X", expEmail: "x@y.fr", imm: "", op: "", statut: "atraiter", assigne: "", nb: 1, dernier: new Date(NOW - 9000e3).toISOString(), attendu: [], notes: [], journal: [] }
  ],
  collaborateurs: [{ nom: "Dieu", email: "dieu@remithollet.fr", fonction: "Architecte" }, { nom: "Marie", email: "m@r.fr", fonction: "Comptabilité" }, { nom: "Thomas", email: "t@r.fr", fonction: "Architecte" }],
  phases: [{ libelle: "Visite", ordre: 1 }, { libelle: "Rapport", ordre: 2 }],
  statutsPhase: [{ libelle: "À faire", couleur: "Gris", ordre: 1 }, { libelle: "Transmise", couleur: "Violet", ordre: 2 }],
  alias: [], avancement: [{ codeOp: "BANQUIER33-A", phase: "Visite", statutPhase: "Transmise" }], regles: [], notifications: [{ cle: "n1", pour: "Dieu", de: "Marie", date: new Date(NOW).toISOString(), texte: "Marie vous a transmis un fil", thread: "t2", lue: false }],
  ops: [{ rid: 1, code: "BANQUIER33-A", imm: "BANQUIER33", archi: "Thomas" }], immeubles: [{ code: "BANQUIER33" }, { code: "DELTA14" }], syndics: []
});

function boot() {
  const calls = [];
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8").replace('<script src="app.js"></script>', "");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const rec = (name, ret) => (...a) => { calls.push([name, ...a]); return Promise.resolve(ret === undefined ? true : ret); };
  w.agoa = {
    state: () => Promise.resolve({ googleConfigured: true, signedIn: true, ragicConfigured: true, ready: true, user: { email: "dieu@remithollet.fr", name: "Dieu" }, collaborateur: { nom: "Dieu" }, collaborateurs: ["Dieu", "Marie", "Thomas"], mailbox: "agence@remithollet.fr", allowedDomain: "remithollet.fr" }),
    data: () => Promise.resolve(data()), onData() {}, sync: () => Promise.resolve({ updated: 0 }),
    thread: () => Promise.resolve({ messages: [{ from: { nom: "A", email: "a@e.fr" }, to: [{ email: "agence@remithollet.fr" }], t: NOW, snippet: "Voici notre devis" }] }),
    suggest: (id) => Promise.resolve(id === "t3" ? { detect: { imm: "DELTA14", op: "DELTA14-A", why: "Le code figure." }, waiting: null } : { detect: null, waiting: null }),
    setMe: () => Promise.resolve({ signedIn: true, ragicConfigured: true, ready: true, collaborateur: { nom: "Marie" }, collaborateurs: ["Dieu", "Marie", "Thomas"], mailbox: "agence@remithollet.fr" }), setStatut: rec("statut"), transfer: rec("transfer"), setRelance: rec("relance"), link: rec("link"), addNote: rec("note"), setPhase: rec("phase"), send: rec("send"), markRead: rec("read"), mergeInto: rec("merge"), saveRecord: rec("save"), removeRecord: rec("remove")
  };
  wins.push(w);
  w.eval(fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"));
  return { w, calls, doc: w.document };
}
const wins = [];
test.after(() => wins.forEach((w) => w.close()));
const tick = () => new Promise((r) => setTimeout(r, 30));
const click = (w, el) => el.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));

test("liste, compteurs de statut et filtre par personne avec « Tous »", async () => {
  const { w, doc } = boot(); await tick();
  assert.equal(doc.querySelectorAll(".th").length, 3);
  assert.match(doc.getElementById("chips").textContent, /Tous 3/);
  assert.match(doc.getElementById("chips").textContent, /En attente 1/);
  // t1 suit l'architecte Thomas ; t2 est transmis à Marie
  click(w, doc.querySelector('[data-action="person"][data-p="Thomas"]')); await tick();
  assert.equal(doc.querySelectorAll(".th").length, 1);
  click(w, doc.querySelector('[data-action="person"][data-p=""]')); await tick();
  assert.equal(doc.querySelectorAll(".th").length, 3);
});

test("détail : statut accessible sans ouvrir le bandeau, phases colorées, messages Gmail", async () => {
  const { w, doc } = boot(); await tick();
  click(w, doc.querySelector('.th[data-id="t1"]')); await tick(); await tick();
  assert.ok(doc.querySelector(".ribbon .stsel"));
  assert.equal(doc.querySelector(".rb-body"), null);
  assert.match(doc.getElementById("detail").textContent, /Réponses attendues : 1 sur 2/);
  assert.match(doc.getElementById("detail").textContent, /Voici notre devis/);
  click(w, doc.querySelector('[data-action="ribbon"]')); await tick();
  assert.ok(doc.querySelector(".ph[data-c]")); assert.equal(doc.querySelectorAll(".ph").length, 2);
});

test("changer le statut et une phase appelle les services", async () => {
  const { w, doc, calls } = boot(); await tick();
  click(w, doc.querySelector('.th[data-id="t1"]')); await tick();
  const sel = doc.querySelector(".stsel"); sel.value = "traite"; sel.dispatchEvent(new w.Event("change", { bubbles: true }));
  click(w, doc.querySelector('[data-action="ribbon"]')); await tick();
  const ps = doc.querySelector('select[data-change="pstat"][data-p="Rapport"]'); ps.value = "Transmise"; ps.dispatchEvent(new w.Event("change", { bubbles: true }));
  assert.deepEqual(calls.filter((c) => c[0] === "statut" || c[0] === "phase"), [["statut", "t1", "traite"], ["phase", "t1", "Rapport", "Transmise"]]);
});

test("glisser un fil sur une personne ouvre la transmission, puis transmet", async () => {
  const { w, doc, calls } = boot(); await tick();
  const ev = (type, target, id) => { const e = new w.Event(type, { bubbles: true, cancelable: true }); e.dataTransfer = { getData: () => id, setData() {} }; target.dispatchEvent(e); };
  ev("drop", doc.querySelector('[data-drop="Thomas"]'), "t3"); await tick();
  assert.match(doc.getElementById("modal").textContent, /Transmettre le fil/);
  doc.getElementById("motif").value = "RDV";
  click(w, doc.querySelector('[data-action="dotransfer"]')); await tick();
  assert.deepEqual(calls.find((c) => c[0] === "transfer"), ["transfer", "t3", "Thomas", "RDV"]);
});

test("suggestion de rattachement et envoi avec confirmation « en attente »", async () => {
  const { w, doc, calls } = boot(); await tick();
  click(w, doc.querySelector('.th[data-id="t3"]')); await tick(); await tick();
  assert.match(doc.getElementById("detail").textContent, /Rattachement proposé : DELTA14-A/);
  click(w, doc.querySelector('[data-action="accept"]'));
  assert.deepEqual(calls.find((c) => c[0] === "link"), ["link", "t3", { imm: "DELTA14", op: "DELTA14-A" }]);
  click(w, doc.querySelector('.th[data-id="t1"]')); await tick(); await tick();
  const set = (id, v) => { const el = doc.getElementById(id); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
  set("mto", "a@e.fr"); set("mbcc", "b@e.fr, c@e.fr"); set("reply", "Bonjour");
  click(w, doc.querySelector('[data-action="send"]')); await tick();
  assert.match(doc.getElementById("modal").textContent, /3 destinataires dont 2 en Cci/);
  click(w, doc.querySelector('[data-action="dosend"][data-m="attente"]')); await tick();
  const s = calls.find((c) => c[0] === "send");
  assert.equal(s[1], "t1"); assert.deepEqual(s[2].bcc, ["b@e.fr", "c@e.fr"]); assert.equal(s[2].mode, "attente");
});

test("options : suppression d'un collaborateur avec confirmation", async () => {
  const { w, doc, calls } = boot(); await tick();
  click(w, doc.querySelector('[data-action="options"]')); await tick();
  assert.equal(doc.querySelectorAll(".urow[data-sheet=collaborateurs]").length, 3);
  click(w, doc.querySelector('[data-action="delcollab"][data-n="Marie"]')); await tick();
  assert.match(doc.getElementById("modal").textContent, /1 fil qui lui est attribué passera en « non attribué »/);
  click(w, doc.querySelector('[data-action="dodelcollab"]')); await tick();
  assert.deepEqual(calls.find((c) => c[0] === "remove"), ["remove", "collaborateurs", "Marie"]);
});

test("qui suis-je : le choix se fait en haut et se retient", async () => {
  const { w, doc, calls } = boot(); await tick();
  assert.equal(doc.getElementById("me").value, "Dieu");
  const sel = doc.getElementById("me"); sel.value = "Marie"; sel.dispatchEvent(new w.Event("change", { bubbles: true })); await tick();
  assert.ok(doc.getElementById("me"));
});
