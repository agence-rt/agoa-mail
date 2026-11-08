(function () {
  "use strict";
  var agoa = window.agoa;
  var STATUTS = [{ id: "nouveau", label: "Nouveau" }, { id: "atraiter", label: "À traiter" }, { id: "attente", label: "En attente" }, { id: "avalider", label: "À valider" }, { id: "traite", label: "Traité" }];
  var COULEURS = ["Gris", "Bleu", "Orange", "Violet", "Vert", "Rouge"];
  var DAY = 86400000;
  var D = { mails: [], collaborateurs: [], phases: [], statutsPhase: [], alias: [], avancement: [], regles: [], notifications: [], ops: [], immeubles: [], syndics: [] };
  var ST = null, loaded = false, lastSync = null, syncErr = "";
  var ui = { sel: null, person: "", imm: "", statut: null, view: "all", q: "", tab: "messages", ribbon: false, bell: false, modal: null, drawer: false, mobileDetail: false, th: {}, draft: { to: {}, bcc: {}, reply: {}, note: {}, from: {} }, opt: "collaborateurs" };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var short = function (s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  var norm = function (s) { return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase(); };
  var ts = function (iso) { var t = Date.parse(iso); return isNaN(t) ? 0 : t; };
  var sod = function (t) { var d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  function fmtDate(t) { var d = new Date(t); return sod(t) === sod(Date.now()) ? d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }); }
  function fmtFull(t) { return new Date(t).toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  function toast(msg) { var el = $("toast"); el.textContent = msg; el.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(function () { el.hidden = true; }, 4500); }
  function fail(e) { if (e && e.code === "needs_reauth") { agoa.state().then(function (s) { ST = s; renderAll(); }); } toast((e && e.message) || "Erreur"); }
  function act(p, okMsg) { return p.then(function (r) { if (okMsg) toast(okMsg); return r; }, fail); }

  /* ---------- modèle ---------- */
  function mail(id) { return D.mails.filter(function (m) { return m.id === id; })[0] || null; }
  function col(nom) { return D.collaborateurs.filter(function (c) { return c.nom === nom; })[0] || null; }
  function handle(c) { return String(c.nom).split(/\s+/)[0]; }
  function opOf(m) { return m.op ? D.ops.filter(function (o) { return o.code === m.op; })[0] || null : null; }
  function archi(m) { var o = opOf(m); return o ? o.archi || "" : ""; }
  function assignee(m) { return m.assigne || archi(m); }
  function code(m) { return m.op || m.imm || ""; }
  function isDue(m) { return !!m.relance && ts(m.relance) <= sod(Date.now()) + DAY - 1 && m.statut !== "traite"; }
  function lastT(m) { return ts(m.dernier) || 0; }
  function recus(m) { return (m.attendu || []).filter(function (d) { return d.recu; }).length; }
  function hue(nom) { var h = 0; String(nom).split("").forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) % 360; }); return h; }
  function avatar(nom) {
    if (!nom) return '<span class="av empty" title="Non assigné">?</span>';
    return '<span class="av" style="background:hsl(' + hue(nom) + ' 45% 38%)" title="' + esc(nom) + '">' + esc(nom.charAt(0)) + "</span>";
  }
  function colorKey(c) { var k = norm(c); return ["gris", "bleu", "orange", "violet", "vert", "rouge"].indexOf(k) >= 0 ? k : "gris"; }
  function sObj(label) { var s = D.statutsPhase.filter(function (x) { return norm(x.libelle) === norm(label); })[0]; return { label: s ? s.libelle : label, color: s ? colorKey(s.couleur) : "gris" }; }
  function defStatut() { return D.statutsPhase.length ? D.statutsPhase[0].libelle : "À faire"; }
  function phaseStatuts(m) {
    var c = code(m), map = {};
    D.avancement.forEach(function (a) { if (a.codeOp === c) map[a.phase] = a.statutPhase; });
    return map;
  }
  function curPhase(m) {
    var map = phaseStatuts(m), best = null, def = norm(defStatut());
    D.phases.forEach(function (p) { var s = map[p.libelle]; if (s && norm(s) !== def && norm(s) !== "sans objet") best = { p: p, s: s }; });
    return best;
  }
  function spill(label) { var s = sObj(label); return '<span class="pill" data-c="' + s.color + '">' + esc(s.label) + "</span>"; }
  function relanceLabel(m) {
    var diff = Math.round((sod(ts(m.relance)) - sod(Date.now())) / DAY);
    return diff < 0 ? "Relance en retard de " + (-diff) + " j" : diff === 0 ? "Relance aujourd’hui" : "Relance dans " + diff + " j";
  }
  function toInputDate(iso) { var d = new Date(ts(iso)), p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
  function me() { return (ST && ST.collaborateur && ST.collaborateur.nom) || ""; }

  function visible(ign) {
    var q = ui.q.trim().toLowerCase();
    return D.mails.filter(function (m) {
      var a = assignee(m);
      if (ui.view === "due" && !isDue(m)) return false;
      if (ui.person === "none" && a) return false;
      if (ui.person && ui.person !== "none" && a !== ui.person) return false;
      if (ui.imm && m.imm !== ui.imm) return false;
      if (!ign && ui.statut && m.statut !== ui.statut) return false;
      if (q && (m.objet + " " + code(m) + " " + m.expediteur + " " + m.expEmail).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return lastT(b) - lastT(a); });
  }

  /* ---------- rendu ---------- */
  function renderGate() {
    var g = $("gate"), app = $("app"), h = "";
    var ready = ST && ST.signedIn && ST.ragicConfigured && ST.ready;
    g.hidden = !!ready; app.hidden = !ready;
    if (ready) return false;
    if (!ST) { g.innerHTML = '<div class="gc"><h1>AGOA ML</h1><p>Chargement…</p></div>'; return true; }
    if (!ST.ragicConfigured) {
      h = "<h1>Clé Ragic introuvable</h1><p>Ouvrez le <strong>lanceur AGOA</strong>, bouton <strong>CONNEXIONS</strong>, enregistrez la clé API Ragic, puis relancez AGOA ML depuis le lanceur.</p>";
    } else if (!ST.signedIn) {
      h = "<h1>Connexion</h1><p>Connectez-vous avec un compte Google de l’agence (@" + esc(ST.allowedDomain) + ") qui a accès à la boîte " + esc(ST.mailbox) + ".</p>" +
        (ST.googleConfigured ? "" : '<p class="sync bad">Cette version n’a pas d’identifiants Google : voir le README (section Google).</p>') +
        '<button class="btn primary" id="gsign"' + (ST.googleConfigured ? "" : " disabled") + ">Se connecter avec Google</button>";
    } else if (ST.starting) {
      h = "<h1>Connexion à Ragic…</h1><p>Chargement de la base de l’agence.</p>";
    } else {
      h = "<h1>Base Ragic incomplète</h1><p>" + esc(ST.error ? ST.error.message : "La base Ragic ne répond pas.") + "</p>" +
        (ST.error && ST.error.problems ? "<ul>" + ST.error.problems.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>" : "") +
        '<button class="btn primary" id="gretry">Réessayer</button>';
    }
    g.innerHTML = '<div class="gc">' + h + "</div>";
    var b = $("gsign"); if (b) b.onclick = function () { b.disabled = true; b.textContent = "En attente de Google…"; agoa.signIn().then(function (s) { ST = s; renderAll(); startAfterLogin(); }, function (e) { fail(e); b.disabled = false; b.textContent = "Se connecter avec Google"; }); };
    b = $("gretry"); if (b) b.onclick = function () { b.disabled = true; agoa.retry().then(function (s) { ST = s; renderAll(); if (s.ready) loadData(); }, fail); };
    return true;
  }

  function renderWho() {
    var mine = D.notifications.filter(function (n) { return n.pour === me(); }).sort(function (a, b) { return ts(b.date) - ts(a.date); });
    var unread = mine.filter(function (n) { return !n.lue; });
    $("who").innerHTML = '<span>' + (me() ? esc(me()) : esc((ST.user && ST.user.name) || "")) + "</span>" + (me() ? "" : '<span class="meta" title="Votre adresse n’est pas dans la feuille Collaborateurs">(sans fiche collaborateur)</span>');
    var panel = "";
    if (ui.bell) {
      panel = '<div class="bell-panel" role="dialog" aria-label="Notifications"><h3>Notifications<button data-action="readall">Tout marquer comme lu</button></h3>' +
        (mine.length ? mine.slice(0, 60).map(function (n) { var m = mail(n.thread); return '<button class="nitem' + (n.lue ? "" : " unread") + '" data-action="bell-item" data-id="' + esc(n.cle) + '">' + esc(n.texte) + '<span class="when">' + esc(fmtFull(ts(n.date))) + (m && code(m) ? " · " + esc(code(m)) : "") + "</span></button>"; }).join("") : '<div class="empty">Aucune notification.</div>') + "</div>";
    }
    $("bellwrap").innerHTML = '<button class="bell" data-action="bell" aria-expanded="' + ui.bell + '">Notifications' + (unread.length ? ' <span class="badge">' + unread.length + "</span>" : "") + "</button>" + panel;
    $("sync").className = "sync" + (syncErr ? " bad" : ""); $("sync").textContent = syncErr ? "Synchro Gmail : " + syncErr : lastSync ? "Synchronisé à " + new Date(lastSync).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
  }

  function renderSide() {
    var open = function (m) { return m.statut !== "traite"; };
    var cnt = function (f) { return D.mails.filter(f).length; };
    var imms = {}; D.mails.forEach(function (m) { if (m.imm) imms[m.imm] = 1; });
    var h = "<h4>Vues</h4>" +
      '<button class="vbtn" data-action="view" data-v="all" aria-current="' + (ui.view === "all" && !ui.person && !ui.imm) + '">Boîte partagée<span class="n">' + D.mails.length + "</span></button>" +
      '<button class="vbtn warnv" data-action="view" data-v="due" aria-current="' + (ui.view === "due") + '">À relancer<span class="n">' + cnt(isDue) + "</span></button>" +
      '<h4>Personnes</h4><p class="dhelp">Glissez un fil sur une personne pour le lui transmettre.</p>' +
      '<button class="vbtn" data-action="person" data-p="" aria-current="' + (!ui.person) + '">Tous<span class="n">' + D.mails.length + "</span></button>" +
      D.collaborateurs.map(function (c) { return '<button class="vbtn" data-drop="' + esc(c.nom) + '" data-action="person" data-p="' + esc(c.nom) + '" aria-current="' + (ui.person === c.nom) + '">' + avatar(c.nom) + esc(c.nom) + (c.nom === me() ? ' <span class="meta">(moi)</span>' : "") + '<span class="n">' + cnt(function (m) { return assignee(m) === c.nom && open(m); }) + "</span></button>"; }).join("") +
      '<button class="vbtn" data-drop="none" data-action="person" data-p="none" aria-current="' + (ui.person === "none") + '">' + avatar(null) + 'Non assigné<span class="n">' + cnt(function (m) { return !assignee(m) && open(m); }) + "</span></button>" +
      "<h4>Immeubles</h4>" + Object.keys(imms).sort().map(function (i) { return '<button class="vbtn" data-action="imm" data-i="' + esc(i) + '" aria-current="' + (ui.imm === i) + '"><span class="code">' + esc(i) + '</span><span class="n">' + cnt(function (m) { return m.imm === i && open(m); }) + "</span></button>"; }).join("");
    $("side").innerHTML = h;
  }

  function renderList() {
    var base = visible(true);
    var chips = '<button class="fchip" data-action="sfilter" data-s="" aria-pressed="' + (!ui.statut) + '">Tous <span class="cn">' + base.length + "</span></button>" +
      STATUTS.map(function (s) { var n = base.filter(function (m) { return m.statut === s.id; }).length; return '<button class="fchip' + (n ? "" : " zero") + '" data-action="sfilter" data-s="' + s.id + '" aria-pressed="' + (ui.statut === s.id) + '">' + esc(s.label) + ' <span class="cn">' + n + "</span></button>"; }).join("");
    if (ui.person) chips += '<button class="fchip active" data-action="person" data-p="">' + (ui.person === "none" ? "Non assigné" : esc(ui.person)) + " ×</button>";
    if (ui.imm) chips += '<button class="fchip active" data-action="imm" data-i="' + esc(ui.imm) + '">' + esc(ui.imm) + " ×</button>";
    $("chips").innerHTML = chips;
    $("threads").innerHTML = visible().map(function (m) {
      var c = code(m), cp = curPhase(m), a = assignee(m);
      return '<li class="th" draggable="true" role="option" tabindex="0" aria-selected="' + (ui.sel === m.id) + '" data-action="open" data-id="' + esc(m.id) + '">' +
        '<div class="th-top"><span class="from">' + esc(m.expediteur || m.expEmail || "—") + (m.nb > 1 ? ' <span class="meta">(' + m.nb + ")</span>" : "") + '</span><span class="date">' + esc(lastT(m) ? fmtDate(lastT(m)) : "") + "</span></div>" +
        '<div class="subject">' + esc(short(m.objet, 84)) + "</div>" +
        '<div class="chips">' + (c ? '<span class="code">' + esc(c) + "</span>" : '<span class="code none">non rattaché</span>') +
        '<span class="pill" data-s="' + m.statut + '">' + esc((STATUTS.filter(function (s) { return s.id === m.statut; })[0] || { label: m.statut }).label) + "</span>" +
        ((m.attendu || []).length ? '<span class="meta">' + recus(m) + "/" + m.attendu.length + " réponses</span>" : "") +
        (cp ? '<span class="meta">' + esc(cp.p.libelle) + "</span>" : "") +
        (isDue(m) ? '<span class="pill late">' + esc(relanceLabel(m)) + "</span>" : "") +
        ((m.notes || []).length ? '<span class="meta">' + m.notes.length + " note" + (m.notes.length > 1 ? "s" : "") + "</span>" : "") +
        (m.assigne && m.assigne !== archi(m) ? '<span class="meta" title="Pris en charge par une autre personne que l’architecte">transmis</span>' : "") + '<span class="grow"></span>' + avatar(a) + "</div></li>";
    }).join("") || '<li class="empty">Aucun fil pour ces filtres.</li>';
  }

  function ribbonHtml(m) {
    var o = opOf(m), c = code(m), a = assignee(m), ar = archi(m), cp = curPhase(m), map = phaseStatuts(m), imm = m.imm;
    var h = '<div class="ribbon' + (ui.ribbon ? "" : " stick") + '"><div class="rb-row">' +
      (c ? '<span class="code">' + esc(c) + "</span>" : '<span class="code none">non rattaché</span>') +
      '<select class="stsel" data-s="' + m.statut + '" data-change="statut" aria-label="Statut du fil">' + STATUTS.map(function (s) { return '<option value="' + s.id + '"' + (m.statut === s.id ? " selected" : "") + ">" + esc(s.label) + "</option>"; }).join("") + "</select>" +
      ((m.attendu || []).length ? '<span class="pill" data-c="violet">Réponses ' + recus(m) + "/" + m.attendu.length + "</span>" : "") +
      (c ? '<span class="rb-ph"><span class="mini" aria-hidden="true">' + D.phases.map(function (p) { var s = map[p.libelle] || defStatut(), so = sObj(s); return '<i data-c="' + so.color + '" data-s="' + (norm(s) === "sans objet" ? "sansobjet" : "") + '" title="' + esc(p.libelle + " : " + so.label) + '"></i>'; }).join("") + "</span>" + (cp ? "<span>" + esc(cp.p.libelle) + "</span>" + spill(cp.s) : '<span class="meta">Non démarrée</span>') + "</span>" : "") +
      '<span class="grow"></span>' + avatar(a) + '<span class="meta">' + (a ? esc(a) : "Non assigné") + (ar && m.assigne && m.assigne !== ar ? " · architecte " + esc(ar) : "") + '</span><button class="btn xs" data-action="transfer">Transmettre…</button>' +
      (m.relance ? '<span class="pill' + (isDue(m) ? " late" : "") + '">' + esc(relanceLabel(m)) + "</span>" : "") +
      '<button class="rb-toggle" data-action="ribbon" aria-expanded="' + ui.ribbon + '">' + (ui.ribbon ? "Réduire ▴" : "Détails ▾") + "</button></div>";
    if (!ui.ribbon) return h + "</div>";
    var opts = D.ops.filter(function (x) { return x.imm === imm; });
    h += '<div class="rb-body"><div class="fields">' +
      '<div class="field"><label for="f-imm">Immeuble</label><select id="f-imm" data-change="imm"><option value="">Non rattaché</option>' + D.immeubles.map(function (i) { return '<option value="' + esc(i.code) + '"' + (imm === i.code ? " selected" : "") + ">" + esc(i.code) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label for="f-op">Opération</label><select id="f-op" data-change="op"' + (imm ? "" : " disabled") + '><option value="">Aucune (immeuble seul)</option>' + opts.map(function (x) { return '<option value="' + esc(x.code) + '"' + (m.op === x.code ? " selected" : "") + ">" + esc(x.code) + "</option>"; }).join("") + (m.op && !o ? '<option value="' + esc(m.op) + '" selected>' + esc(m.op) + " (pas encore dans Ragic)</option>" : "") + "</select></div>" +
      '<div class="field"><label for="f-as">Pris en charge par</label><select id="f-as" data-change="assigne"><option value="">' + (ar ? "Architecte de l’opération (" + esc(ar) + ")" : "Personne") + "</option>" + D.collaborateurs.map(function (u) { return '<option value="' + esc(u.nom) + '"' + (m.assigne === u.nom ? " selected" : "") + ">" + esc(u.nom) + "</option>"; }).join("") + "</select></div>" +
      '<div class="field"><label for="f-re">Relance le</label><input id="f-re" type="date" data-change="relance" value="' + (m.relance ? toInputDate(m.relance) : "") + '"><div class="quick"><button data-action="rq" data-d="2">+2 j</button><button data-action="rq" data-d="7">+1 sem.</button><button data-action="rq" data-d="">Effacer</button></div></div></div>';
    if (c) {
      h += "<div><h5>Avancement de " + esc(c) + (o ? "" : ' <span class="meta">opération pas encore dans Ragic : l’information est conservée</span>') + '<button data-action="options" data-t="phases">Gérer les phases et statuts</button></h5><div class="phases">' +
        D.phases.map(function (p) { var s = map[p.libelle] || defStatut(), so = sObj(s); return '<div class="ph" data-c="' + so.color + '"><span class="nm">' + esc(p.libelle) + '</span><select data-change="pstat" data-p="' + esc(p.libelle) + '" aria-label="' + esc(p.libelle) + '">' + D.statutsPhase.map(function (x) { return '<option' + (norm(x.libelle) === norm(s) ? " selected" : "") + ">" + esc(x.libelle) + "</option>"; }).join("") + "</select></div>"; }).join("") + "</div></div>";
    } else h += '<div class="linked">Rattachez le fil à un immeuble pour suivre l’avancement.</div>';
    if (imm) h += '<div><h5>Opération prévue sur ' + esc(imm) + '</h5><div class="inline"><input id="nopl" class="l" type="text" maxlength="3" placeholder="Indice" aria-label="Indice de l’opération (A, B, A5…)"><button class="btn" data-action="newop">Rattacher à ' + esc(imm) + '-…</button></div><p class="help">À utiliser quand l’opération n’existe pas encore dans Ragic : l’avancement saisi ici sera repris à sa création.</p></div>';
    return h + "</div></div>";
  }

  function renderDetail() {
    var el = $("detail"), m = mail(ui.sel);
    if (!m) { el.innerHTML = '<div class="none-sel">Sélectionnez un fil.</div>'; return; }
    var sg = ui.th["s:" + m.id];
    var h = '<div class="detail-inner"><button class="back" data-action="back">Retour aux fils</button>' + ribbonHtml(m);
    h += '<div class="dh"><h2>' + esc(m.objet) + '</h2><div class="sub">' + esc(m.expediteur) + " · " + esc(m.expEmail) + (m.alias ? " · reçu sur " + esc(m.alias) : "") + (m.lien ? ' · <a href="' + esc(m.lien) + '" target="_blank" rel="noopener">Ouvrir dans Gmail</a>' : "") + "</div></div>";
    if (sg && sg.waiting) h += '<div class="sugg"><p><strong>Rapprochement proposé</strong><br>' + esc(m.expediteur) + " fait partie des destinataires attendus du fil « " + esc(short(sg.waiting.objet, 60)) + " ». Rapprocher ce mail le fera repasser à « À traiter ».</p><button class=\"btn primary\" data-action=\"merge\" data-id=\"" + esc(sg.waiting.id) + '">Rapprocher</button></div>';
    if (sg && sg.detect) h += '<div class="sugg"><p><strong>Rattachement proposé : <span class="code">' + esc(sg.detect.op || sg.detect.imm) + "</span></strong><br>" + esc(sg.detect.why) + '</p><button class="btn primary" data-action="accept">Rattacher</button></div>';
    var jn = (m.journal || []).length, nn = (m.notes || []).length;
    h += '<div class="tabs" role="tablist">' + [["messages", "Messages", m.nb || 0], ["notes", "Notes internes", nn], ["journal", "Journal", jn]].map(function (x) { return '<button class="tab" role="tab" data-action="tab" data-t="' + x[0] + '" aria-selected="' + (ui.tab === x[0]) + '">' + x[1] + '<span class="n">' + x[2] + "</span></button>"; }).join("") + "</div>";
    if (ui.tab === "messages") {
      h += '<div class="stack">';
      if ((m.attendu || []).length) {
        h += '<div class="card wait"><h5>Réponses attendues : ' + recus(m) + " sur " + m.attendu.length + "</h5>" + m.attendu.map(function (d) { return '<div class="wrow"><span class="nm">' + esc(d.nom || d.email) + ' <span class="meta">' + esc(d.email) + "</span></span>" + (d.recu ? '<span class="pill" data-c="vert">Réponse reçue</span>' : '<span class="pill" data-c="orange">En attente</span>') + "</div>"; }).join("") + '<p class="help">Dès qu’une réponse arrive, dans ce fil ou dans un mail séparé d’un destinataire attendu, le fil repasse à « À traiter » et le mail est rapproché ici.</p></div>';
      }
      var t = ui.th[m.id];
      if (!t) h += '<div class="empty">Chargement des messages…</div>';
      else if (t.error) h += '<div class="empty">' + esc(t.error) + "</div>";
      else h += t.messages.map(function (g) { var ag = /@remithollet\.fr$/i.test(g.from.email); return '<div class="card msg' + (ag ? " out" : "") + '"><div class="msg-h"><span><span class="nm">' + esc(g.from.nom || g.from.email) + '</span> <span class="org">' + esc(g.from.email) + '</span></span><span class="meta">' + esc(fmtFull(g.t)) + '</span></div><div class="to">À : ' + esc(g.to.map(function (x) { return x.email; }).filter(function (x, i, a) { return a.indexOf(x) === i; }).join(", ")) + '</div><p class="snipb">' + esc(g.snippet) + "</p></div>"; }).join("") + '<p class="help">Aperçu des messages. Le texte complet se lit dans Gmail (lien ci-dessus).</p>';
      var aliases = [ST.mailbox].concat((D.alias || []).map(function (x) { return x.adresse; }));
      var dTo = ui.draft.to[m.id] !== undefined ? ui.draft.to[m.id] : (m.expEmail || "");
      h += '<div class="card composer"><div class="cf"><label for="mfrom">De</label><select id="mfrom" data-draft="from">' + aliases.map(function (a) { return "<option" + ((ui.draft.from[m.id] || ST.mailbox) === a ? " selected" : "") + ">" + esc(a) + "</option>"; }).join("") + '</select><label for="mto">À</label><input id="mto" type="text" data-draft="to" value="' + esc(dTo) + '" placeholder="adresse@exemple.fr"><label for="mbcc">Cci</label><input id="mbcc" type="text" data-draft="bcc" value="' + esc(ui.draft.bcc[m.id] || "") + '" placeholder="Plusieurs adresses séparées par des virgules"></div>' +
        '<textarea id="reply" data-draft="reply" placeholder="Écrire un message">' + esc(ui.draft.reply[m.id] || "") + '</textarea><div class="row"><span class="grow"></span><button class="btn primary" data-action="send">Envoyer…</button></div></div></div>';
    } else if (ui.tab === "notes") {
      h += '<div class="stack">' + (nn ? m.notes.map(function (n) { return '<div class="note"><div class="note-h">' + avatar(n.auteur) + "<strong>" + esc(n.auteur) + '</strong><span class="meta">' + esc(fmtFull(n.t)) + "</span></div><p>" + mentions(esc(n.texte)) + "</p></div>"; }).join("") : '<div class="empty">Aucune note sur ce fil.</div>') +
        '<div class="card composer"><label for="note" class="help">Visible uniquement par l’équipe. Une @mention envoie une notification à la personne.</label><textarea id="note" data-draft="note" placeholder="Ajouter une note pour l’équipe">' + esc(ui.draft.note[m.id] || "") + '</textarea><div class="row">' +
        D.collaborateurs.filter(function (u) { return u.nom !== me(); }).map(function (u) { return '<button class="mchip" data-action="mention" data-h="' + esc(handle(u)) + '">@' + esc(handle(u)) + "</button>"; }).join("") + '<span class="grow"></span><button class="btn primary" data-action="addnote">Ajouter la note</button></div></div></div>';
    } else {
      var j = (m.journal || []).slice().sort(function (a, b) { return b.t - a.t; });
      h += j.length ? '<ul class="card log">' + j.map(function (e) { return "<li><span class=\"meta\">" + esc(fmtFull(e.t)) + "</span><span>" + (e.par ? "<strong>" + esc(e.par) + "</strong> " : "") + esc(e.texte) + "</span></li>"; }).join("") + "</ul>" : '<div class="empty">Aucun événement.</div>';
    }
    el.innerHTML = h + "</div>";
  }
  function mentions(s) { return s.replace(/@([A-Za-zÀ-ÿ]+)/g, function (x, n) { return D.collaborateurs.some(function (u) { return handle(u).toLowerCase() === n.toLowerCase(); }) ? '<span class="mention">' + x + "</span>" : x; }); }

  function renderModal() {
    var el = $("modal"), md = ui.modal;
    if (!md) { el.hidden = true; el.innerHTML = ""; return; }
    var h = "";
    if (md.type === "send") {
      var m = mail(md.id), d = md.data, all = d.to.concat(d.bcc.filter(function (x) { return d.to.indexOf(x) < 0; }));
      h = '<div class="modal" role="dialog" aria-label="Envoi"><h3>Envoyer ce message</h3><p>' + all.length + " destinataire" + (all.length > 1 ? "s" : "") + (d.bcc.length ? " dont " + d.bcc.length + " en Cci" : "") + " :</p><ul class=\"dest\">" + all.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>" +
        "<p>Voulez-vous attendre une réponse de chacun ? Le fil passera « En attente », puis repassera à « À traiter » dès qu’une réponse arrivera (dans ce fil ou dans un mail séparé).</p>" +
        '<div class="actions"><button class="btn" data-action="close">Annuler</button><button class="btn" data-action="dosend" data-m="normal">Envoyer sans attente</button><button class="btn primary" data-action="dosend" data-m="attente">Envoyer et passer « En attente »</button></div></div>';
    } else if (md.type === "transfer") {
      var tm = mail(md.id);
      h = '<div class="modal" role="dialog" aria-label="Transmettre"><h3>Transmettre le fil</h3><p>« ' + esc(short(tm.objet, 80)) + " »</p><div class=\"pick\" role=\"radiogroup\">" +
        D.collaborateurs.map(function (c) { return '<button class="pk" role="radio" aria-checked="' + (md.to === c.nom) + '" data-action="pickto" data-p="' + esc(c.nom) + '">' + avatar(c.nom) + esc(c.nom) + "</button>"; }).join("") + '<button class="pk" role="radio" aria-checked="' + (md.to === "") + '" data-action="pickto" data-p="">' + avatar(null) + "Rendre à l’architecte</button></div>" +
        '<div class="field" style="margin-top:10px"><label for="motif">Motif (facultatif)</label><input id="motif" type="text" placeholder="prise de rendez-vous, facturation…" value="' + esc(md.motif || "") + '"></div><div class="actions"><button class="btn" data-action="close">Annuler</button><button class="btn primary" data-action="dotransfer">Transmettre</button></div></div>';
    } else if (md.type === "delcollab") {
      var n = D.mails.filter(function (x) { return x.assigne === md.nom; }).length;
      h = '<div class="modal" role="dialog"><h3>Supprimer ' + esc(md.nom) + " ?</h3><p>" + n + " fil" + (n > 1 ? "s" : "") + " qui lui " + (n > 1 ? "sont attribués passeront" : "est attribué passera") + " en « non attribué ». Ses notifications seront supprimées. Les fiches OPERATIONS de Ragic ne sont pas modifiées.</p>" +
        '<div class="actions"><button class="btn" data-action="options">Annuler</button><button class="btn danger" data-action="dodelcollab" data-n="' + esc(md.nom) + '">Supprimer</button></div></div>';
    } else if (md.type === "options") h = optionsHtml();
    el.innerHTML = '<div class="overlay">' + h + "</div>"; el.hidden = false;
  }

  function optionsHtml() {
    var tabs = [["collaborateurs", "Collaborateurs"], ["phases", "Phases"], ["statutsPhase", "Statuts de phase"], ["alias", "Alias"]];
    var h = '<div class="modal" role="dialog" aria-label="Options"><h3>Options</h3><div class="otabs">' + tabs.map(function (t) { return '<button class="tab" data-action="otab" data-t="' + t[0] + '" aria-selected="' + (ui.opt === t[0]) + '">' + t[1] + "</button>"; }).join("") + "</div>";
    if (ui.opt === "collaborateurs") {
      h += D.collaborateurs.map(function (c) { return '<div class="urow" data-sheet="collaborateurs" data-key="' + esc(c.nom) + '">' + avatar(c.nom) + '<input type="text" data-f="nom" value="' + esc(c.nom) + '" aria-label="Nom"><input type="text" data-f="email" value="' + esc(c.email) + '" placeholder="e-mail" aria-label="E-mail"><input type="text" data-f="fonction" value="' + esc(c.fonction) + '" placeholder="fonction" aria-label="Fonction"><label class="chk"><input type="checkbox" data-f="valideur"' + (c.valideur ? " checked" : "") + '>valide</label><button class="btn xs danger" data-action="delcollab" data-n="' + esc(c.nom) + '">Supprimer</button></div>'; }).join("") +
        '<div class="urow add"><input type="text" id="nc-nom" placeholder="Nom"><input type="text" id="nc-email" placeholder="e-mail"><input type="text" id="nc-fn" placeholder="fonction"><button class="btn xs" data-action="addcollab">Ajouter</button></div><p class="help">Le nom doit correspondre au prénom saisi dans « Architecte ? » des opérations Ragic.</p>';
    } else if (ui.opt === "phases") {
      h += D.phases.map(function (p, i) { return '<div class="orow" data-sheet="phases" data-key="' + esc(p.libelle) + '"><span class="meta">' + (i + 1) + '</span><input type="text" data-f="libelle" value="' + esc(p.libelle) + '" aria-label="Phase"><span class="ord"><button data-action="up" data-sheet="phases" data-key="' + esc(p.libelle) + '" aria-label="Monter">↑</button><button data-action="down" data-sheet="phases" data-key="' + esc(p.libelle) + '" aria-label="Descendre">↓</button></span><button class="btn xs danger" data-action="delrec" data-sheet="phases" data-key="' + esc(p.libelle) + '">Retirer</button></div>'; }).join("") +
        '<div class="orow add"><span></span><input type="text" id="np-lib" placeholder="Nouvelle phase"><span></span><button class="btn xs" data-action="addphase">Ajouter</button></div>';
    } else if (ui.opt === "statutsPhase") {
      h += D.statutsPhase.map(function (s, i) { return '<div class="orow" data-sheet="statutsPhase" data-key="' + esc(s.libelle) + '"><span class="meta">' + (i + 1) + '</span><input type="text" data-f="libelle" value="' + esc(s.libelle) + '" aria-label="Statut"><select data-f="couleur" data-c="' + colorKey(s.couleur) + '">' + COULEURS.map(function (c) { return "<option" + (norm(c) === norm(s.couleur) ? " selected" : "") + ">" + c + "</option>"; }).join("") + '</select><span class="ord"><button data-action="up" data-sheet="statutsPhase" data-key="' + esc(s.libelle) + '">↑</button><button data-action="down" data-sheet="statutsPhase" data-key="' + esc(s.libelle) + '">↓</button><button class="btn xs danger" data-action="delrec" data-sheet="statutsPhase" data-key="' + esc(s.libelle) + '">×</button></span></div>'; }).join("") +
        '<div class="orow add"><span></span><input type="text" id="ns-lib" placeholder="Nouveau statut"><select id="ns-col">' + COULEURS.map(function (c) { return "<option>" + c + "</option>"; }).join("") + '</select><button class="btn xs" data-action="addstat">Ajouter</button></div><p class="help">Le premier statut est celui d’une phase non commencée.</p>';
    } else {
      h += D.alias.map(function (a) { return '<div class="orow" data-sheet="alias" data-key="' + esc(a.adresse) + '"><span></span><input type="text" data-f="adresse" value="' + esc(a.adresse) + '" aria-label="Alias"><select data-f="collaborateur"><option value="">Personne</option>' + D.collaborateurs.map(function (c) { return "<option" + (c.nom === a.collaborateur ? " selected" : "") + ">" + esc(c.nom) + "</option>"; }).join("") + '</select><button class="btn xs danger" data-action="delrec" data-sheet="alias" data-key="' + esc(a.adresse) + '">×</button></div>'; }).join("") +
        '<div class="orow add"><span></span><input type="text" id="na-adr" placeholder="alias@remithollet.fr"><span></span><button class="btn xs" data-action="addalias">Ajouter</button></div><p class="help">Un fil reçu sur un alias est attribué à la personne choisie.</p>';
    }
    return h + '<div class="actions"><button class="btn primary" data-action="close">Fermer</button></div></div>';
  }

  function renderAll() {
    if (renderGate()) return;
    renderWho(); renderSide(); renderList(); renderDetail(); renderModal();
    $("app").className = (ui.drawer ? "m-drawer " : "") + (ui.mobileDetail ? "m-detail" : "");
  }

  /* ---------- données ---------- */
  function applyData(d) { D = d; loaded = true; if (ui.sel && !mail(ui.sel)) ui.sel = null; if (ui.sel) loadSuggest(ui.sel); renderAll(); }
  function loadData() { return agoa.data().then(applyData, fail); }
  function loadThread(id) {
    if (ui.th[id]) return;
    agoa.thread(id).then(function (t) { ui.th[id] = t; if (ui.sel === id) renderDetail(); }, function (e) { ui.th[id] = { error: e.message || "Messages indisponibles", messages: [] }; if (ui.sel === id) renderDetail(); });
  }
  function loadSuggest(id) {
    agoa.suggest(id).then(function (s) { var k = JSON.stringify(s); if (ui.th["sk:" + id] !== k) { ui.th["sk:" + id] = k; ui.th["s:" + id] = s; if (ui.sel === id) renderDetail(); } }, function () {});
  }
  function doSync(manual) {
    return agoa.sync().then(function (r) { lastSync = Date.now(); syncErr = ""; if (manual) toast(r.updated ? r.updated + " fil(s) mis à jour" : "Rien de nouveau"); renderWho(); }, function (e) { syncErr = e.message || "erreur"; renderWho(); if (manual) fail(e); });
  }
  function startAfterLogin() { if (ST && ST.ready) { loadData().then(function () { return doSync(false); }); } }

  /* ---------- événements ---------- */
  function parseRcpt(s) { return String(s || "").split(/[,;\s]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); }); }
  function saveRow(row, patch) {
    var sheet = row.dataset.sheet, key = row.dataset.key, cur = null;
    var list = sheet === "collaborateurs" ? D.collaborateurs : sheet === "phases" ? D.phases : sheet === "statutsPhase" ? D.statutsPhase : D.alias;
    var kf = { collaborateurs: "nom", phases: "libelle", statutsPhase: "libelle", alias: "adresse" }[sheet];
    list.forEach(function (x) { if (x[kf] === key) cur = x; });
    if (!cur) return;
    var rec = Object.assign({}, cur, patch); if (rec[kf] !== key) rec._renameFrom = key;
    act(agoa.saveRecord(sheet, rec), "Enregistré");
  }
  function move(sheet, key, dir) {
    var list = sheet === "phases" ? D.phases : D.statutsPhase, i = list.map(function (x) { return x.libelle; }).indexOf(key), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    var a = list[i], b = list[j];
    Promise.all([agoa.saveRecord(sheet, Object.assign({}, a, { ordre: j + 1 })), agoa.saveRecord(sheet, Object.assign({}, b, { ordre: i + 1 }))]).catch(fail);
  }

  document.addEventListener("click", function (e) {
    if (e.target.classList && e.target.classList.contains("overlay")) { ui.modal = null; renderModal(); return; }
    var el = e.target.closest("[data-action]");
    if (!el) { if (ui.bell && !e.target.closest(".bell-wrap")) { ui.bell = false; renderWho(); } return; }
    var a = el.dataset.action, m = mail(ui.sel), d = el.dataset;
    if (a === "view") { ui.view = d.v; if (d.v === "all") { ui.person = ""; ui.imm = ""; ui.statut = null; } ui.drawer = false; ui.mobileDetail = false; renderAll(); }
    else if (a === "person") { ui.person = d.p; ui.view = "all"; ui.drawer = false; renderAll(); }
    else if (a === "imm") { ui.imm = ui.imm === d.i ? "" : d.i; ui.drawer = false; renderAll(); }
    else if (a === "sfilter") { ui.statut = d.s || null; renderList(); }
    else if (a === "open") { ui.sel = d.id; ui.mobileDetail = true; ui.tab = "messages"; loadThread(d.id); loadSuggest(d.id); renderAll(); }
    else if (a === "back") { ui.mobileDetail = false; renderAll(); }
    else if (a === "drawer") { ui.drawer = !ui.drawer; renderAll(); }
    else if (a === "ribbon") { ui.ribbon = !ui.ribbon; renderDetail(); }
    else if (a === "tab") { ui.tab = d.t; renderDetail(); }
    else if (a === "refresh") { doSync(true).then(loadData); }
    else if (a === "bell") { ui.bell = !ui.bell; renderWho(); }
    else if (a === "readall") { D.notifications.filter(function (n) { return n.pour === me() && !n.lue; }).forEach(function (n) { agoa.markRead(n.cle).catch(fail); }); }
    else if (a === "bell-item") { agoa.markRead(d.id).catch(fail); var n = D.notifications.filter(function (x) { return x.cle === d.id; })[0]; if (n && mail(n.thread)) { ui.sel = n.thread; ui.bell = false; ui.mobileDetail = true; loadThread(n.thread); loadSuggest(n.thread); renderAll(); } }
    else if (a === "transfer") { ui.modal = { type: "transfer", id: m.id, to: assignee(m) || "", motif: "" }; renderModal(); }
    else if (a === "pickto") { ui.modal.to = d.p; ui.modal.motif = ($("motif") || {}).value || ""; renderModal(); }
    else if (a === "dotransfer") { var mt = ($("motif") || {}).value || "", md = ui.modal; ui.modal = null; renderModal(); act(agoa.transfer(md.id, md.to, mt), md.to ? "Fil transmis à " + md.to : "Fil rendu"); }
    else if (a === "close") { ui.modal = null; renderModal(); }
    else if (a === "rq") { act(agoa.setRelance(m.id, d.d ? new Date(Date.now() + Number(d.d) * DAY).toISOString() : ""), d.d ? "Relance programmée" : "Relance effacée"); }
    else if (a === "accept") { var sg = ui.th["s:" + m.id]; if (sg && sg.detect) act(agoa.link(m.id, { imm: sg.detect.imm, op: sg.detect.op }), "Fil rattaché à " + (sg.detect.op || sg.detect.imm)); }
    else if (a === "merge") { act(agoa.mergeInto(m.id, d.id), "Mail rapproché : le fil repasse à « À traiter »"); ui.sel = d.id; }
    else if (a === "newop") { var l = (($("nopl") || {}).value || "").trim().toUpperCase(); if (!/^[A-Z][A-Z0-9]{0,2}$/.test(l)) { toast("L’indice commence par une lettre : A, B, A5, J…"); return; } act(agoa.link(m.id, { imm: m.imm, op: m.imm + "-" + l }), "Fil rattaché à " + m.imm + "-" + l); }
    else if (a === "mention") { var ta = $("note"); ta.value += (ta.value && !/\s$/.test(ta.value) ? " " : "") + "@" + d.h + " "; ui.draft.note[m.id] = ta.value; ta.focus(); }
    else if (a === "addnote") { var txt = ($("note").value || "").trim(); if (!txt) { toast("Écrivez une note avant de l’ajouter"); return; } ui.draft.note[m.id] = ""; act(agoa.addNote(m.id, txt), "Note ajoutée"); }
    else if (a === "send") {
      var to = parseRcpt(ui.draft.to[m.id] !== undefined ? ui.draft.to[m.id] : m.expEmail), bcc = parseRcpt(ui.draft.bcc[m.id]);
      if (!(ui.draft.reply[m.id] || "").trim()) { toast("Écrivez un message avant d’envoyer"); return; }
      if (!to.length && !bcc.length) { toast("Ajoutez au moins un destinataire (À ou Cci)"); return; }
      ui.modal = { type: "send", id: m.id, data: { to: to, bcc: bcc } }; renderModal();
    }
    else if (a === "dosend") {
      var sd = ui.modal.data, sid = ui.modal.id, sm = mail(sid); ui.modal = null; renderModal();
      act(agoa.send(sid, { to: sd.to, bcc: sd.bcc, subject: /^(re|tr)\s*:/i.test(sm.objet) ? sm.objet : "Re: " + sm.objet, body: ui.draft.reply[sid], from: ui.draft.from[sid] || undefined, mode: d.m }), d.m === "attente" ? "Message envoyé : fil « En attente »" : "Message envoyé").then(function (r) { if (r) { ui.draft.reply[sid] = ""; ui.draft.bcc[sid] = ""; delete ui.draft.to[sid]; delete ui.th[sid]; loadThread(sid); renderDetail(); } });
    }
    else if (a === "options") { ui.modal = { type: "options" }; if (d.t) ui.opt = d.t; renderModal(); }
    else if (a === "otab") { ui.opt = d.t; renderModal(); }
    else if (a === "addcollab") { var nm = ($("nc-nom").value || "").trim(); if (!nm) { toast("Saisissez un nom"); return; } act(agoa.saveRecord("collaborateurs", { nom: nm, email: $("nc-email").value.trim(), fonction: $("nc-fn").value.trim(), valideur: false, actif: true }), "Collaborateur ajouté"); }
    else if (a === "delcollab") { ui.modal = { type: "delcollab", nom: d.n }; renderModal(); }
    else if (a === "dodelcollab") { if (ui.person === d.n) ui.person = ""; ui.modal = { type: "options" }; renderModal(); act(agoa.removeRecord("collaborateurs", d.n), "Collaborateur supprimé : ses fils sont non attribués"); }
    else if (a === "addphase") { var pl = ($("np-lib").value || "").trim(); if (pl) act(agoa.saveRecord("phases", { libelle: pl, ordre: D.phases.length + 1, actif: true }), "Phase ajoutée"); }
    else if (a === "addstat") { var sl = ($("ns-lib").value || "").trim(); if (sl) act(agoa.saveRecord("statutsPhase", { libelle: sl, couleur: $("ns-col").value, ordre: D.statutsPhase.length + 1, systeme: false }), "Statut ajouté"); }
    else if (a === "addalias") { var ad = ($("na-adr").value || "").trim().toLowerCase(); if (ad) act(agoa.saveRecord("alias", { adresse: ad, collaborateur: "" }), "Alias ajouté"); }
    else if (a === "delrec") { act(agoa.removeRecord(d.sheet, d.key), "Retiré"); }
    else if (a === "up") move(d.sheet, d.key, -1);
    else if (a === "down") move(d.sheet, d.key, 1);
  });

  document.addEventListener("change", function (e) {
    var t = e.target, m = mail(ui.sel), k = t.dataset && t.dataset.change;
    if (t.dataset && t.dataset.f && t.closest("[data-sheet]")) { var row = t.closest("[data-sheet]"), f = t.dataset.f, v = t.type === "checkbox" ? t.checked : t.value; var p = {}; p[f] = typeof v === "string" ? v.trim() : v; saveRow(row, p); return; }
    if (!k || !m) return;
    if (k === "statut") act(agoa.setStatut(m.id, t.value), "Statut mis à jour");
    else if (k === "assigne") act(agoa.transfer(m.id, t.value, ""), t.value ? "Fil transmis à " + t.value : "Fil rendu");
    else if (k === "imm") act(agoa.link(m.id, { imm: t.value, op: "" }));
    else if (k === "op") act(agoa.link(m.id, { imm: m.imm, op: t.value }));
    else if (k === "relance") act(agoa.setRelance(m.id, t.value ? new Date(t.value + "T09:00:00").toISOString() : ""), t.value ? "Relance programmée" : "Relance effacée");
    else if (k === "pstat") act(agoa.setPhase(m.id, t.dataset.p, t.value), "Avancement enregistré");
  });
  document.addEventListener("input", function (e) {
    var t = e.target; if (t.id === "q") { ui.q = t.value; renderList(); return; }
    if (t.dataset && t.dataset.draft && ui.sel) ui.draft[t.dataset.draft][ui.sel] = t.value;
  });

  /* glisser-déposer d'un fil sur une personne */
  document.addEventListener("dragstart", function (e) { var li = e.target.closest && e.target.closest(".th"); if (!li) return; e.dataTransfer.setData("text/plain", li.dataset.id); e.dataTransfer.effectAllowed = "move"; li.classList.add("dragging"); });
  document.addEventListener("dragend", function (e) { var li = e.target.closest && e.target.closest(".th"); if (li) li.classList.remove("dragging"); document.querySelectorAll(".vbtn.drop").forEach(function (x) { x.classList.remove("drop"); }); });
  document.addEventListener("dragover", function (e) { var b = e.target.closest && e.target.closest("[data-drop]"); if (b) { e.preventDefault(); b.classList.add("drop"); } });
  document.addEventListener("dragleave", function (e) { var b = e.target.closest && e.target.closest("[data-drop]"); if (b) b.classList.remove("drop"); });
  document.addEventListener("drop", function (e) {
    var b = e.target.closest && e.target.closest("[data-drop]"); if (!b) return; e.preventDefault(); b.classList.remove("drop");
    var id = e.dataTransfer.getData("text/plain"), m = mail(id); if (!m) return;
    var to = b.dataset.drop === "none" ? "" : b.dataset.drop;
    if (!to) { act(agoa.transfer(id, "", ""), "Fil rendu"); return; }
    ui.modal = { type: "transfer", id: id, to: to, motif: "" }; renderModal();
  });

  /* ---------- démarrage ---------- */
  agoa.onData(applyData);
  agoa.state().then(function (s) {
    ST = s; renderAll();
    if (s.ready) { loadData().then(function () { return doSync(false); }); }
    else if (s.signedIn === false || s.starting) { var iv = setInterval(function () { agoa.state().then(function (x) { ST = x; if (x.ready) { clearInterval(iv); loadData().then(function () { return doSync(false); }); } renderAll(); }); }, 1500); }
  }, fail);
  setInterval(function () { if (ST && ST.ready) { agoa.state().then(function (x) { ST = x; renderWho(); }); } }, 60000);
})();
