"use strict";
/* Lecture et envoi Gmail (API REST) pour la boîte partagée. `auth.accessToken()` fournit le jeton (GoogleAuth). */
const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

class GmailError extends Error { constructor(code, message, status) { super(message); this.name = "GmailError"; this.code = code; this.status = status; } }

/** "Nom <a@b.fr>, c@d.fr" -> [{ nom, email }] */
function parseAddresses(h) {
  const out = [];
  String(h || "").replace(/("([^"]*)"|[^,<]*?)\s*<([^>]+)>|([^,\s<>]+@[^,\s<>]+)/g, (_m, nm, quoted, mail, bare) => {
    const email = String(mail || bare || "").trim().toLowerCase();
    if (email) out.push({ nom: String(quoted != null ? quoted : (nm || "")).replace(/^"|"$/g, "").trim(), email });
    return "";
  });
  return out;
}
const decodeWord = (s) => String(s || "").replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_m, enc, txt) => {
  try { return enc.toUpperCase() === "B" ? Buffer.from(txt, "base64").toString("utf8") : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"); } catch (e) { return txt; }
});

/** Réponse Gmail (format metadata) -> fil normalisé. */
function normalizeThread(t) {
  const msgs = (t.messages || []).map((m) => {
    const h = {}; ((m.payload && m.payload.headers) || []).forEach((x) => { h[x.name.toLowerCase()] = x.value; });
    const from = parseAddresses(h.from)[0] || { nom: "", email: "" };
    return {
      id: m.id, t: Number(m.internalDate) || 0, from: { nom: decodeWord(from.nom), email: from.email },
      to: parseAddresses(h.to).concat(parseAddresses(h["delivered-to"])), cc: parseAddresses(h.cc),
      objet: decodeWord(h.subject || ""), labels: m.labelIds || [], snippet: m.snippet || ""
    };
  }).sort((a, b) => a.t - b.t);
  return { id: t.id, objet: msgs.length ? msgs[0].objet : "", messages: msgs };
}

class Gmail {
  constructor({ auth, fetchImpl }) { this.auth = auth; this.fetch = fetchImpl || ((...a) => fetch(...a)); }
  async _get(path) {
    const token = await this.auth.accessToken();
    const res = await this.fetch(BASE + path, { headers: { Authorization: "Bearer " + token } });
    if (res.status === 401) throw new GmailError("needs_reauth", "Session Google expirée : reconnectez-vous.", 401);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && /scope|insufficient/i.test(JSON.stringify(j))) {   // session sans le droit de lecture : on l'oublie pour obtenir une nouvelle autorisation complète
        this.auth.forget && this.auth.forget();
        throw new GmailError("needs_reauth", "La session Google n’a pas le droit de lire la boîte. Reconnectez-vous et cochez TOUS les droits demandés (lecture et modification des e-mails).", 403);
      }
      throw new GmailError("gmail", (j.error && j.error.message) || "Gmail a répondu " + res.status, res.status);
    }
    return res.json();
  }
  /** Fils récents : [{ id, historyId }]. */
  async listThreads({ q, max = 100 }) {
    const j = await this._get(`/threads?maxResults=${max}&q=${encodeURIComponent(q || "")}`);
    return j.threads || [];
  }
  async getThread(id) {
    const j = await this._get(`/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Delivered-To`);
    return normalizeThread(j);
  }
  async send({ from, to = [], cc = [], bcc = [], subject, body, threadId, inReplyTo }) {
    const token = await this.auth.accessToken();
    const enc = (s) => `=?UTF-8?B?${Buffer.from(String(s), "utf8").toString("base64")}?=`;
    const lines = [from ? `From: ${from}` : null, to.length ? `To: ${to.join(", ")}` : null, cc.length ? `Cc: ${cc.join(", ")}` : null, bcc.length ? `Bcc: ${bcc.join(", ")}` : null,
      `Subject: ${enc(subject)}`, inReplyTo ? `In-Reply-To: ${inReplyTo}` : null, inReplyTo ? `References: ${inReplyTo}` : null,
      "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "",
      Buffer.from(String(body).replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n")].filter((x) => x !== null);
    const res = await this.fetch(BASE + "/messages/send", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: b64url(Buffer.from(lines.join("\r\n"), "utf8")), threadId: threadId || undefined })
    });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new GmailError("send", (j.error && j.error.message) || "Gmail a refusé l’envoi.", res.status); }
    return res.json();
  }
}

module.exports = { Gmail, GmailError, parseAddresses, normalizeThread, decodeWord };
