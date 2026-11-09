"use strict";
/* Identification Google (OAuth 2.0 « application installée » : navigateur système + PKCE + retour local)
   et envoi de courriel par l'API Gmail au nom de la personne connectée. */
const crypto = require("crypto");
const http = require("http");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pkcePair = () => { const verifier = b64url(crypto.randomBytes(32)); return { verifier, challenge: b64url(crypto.createHash("sha256").update(verifier).digest()) }; };
const decodeIdToken = (t) => JSON.parse(Buffer.from(String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));

class AuthError extends Error { constructor(code, message) { super(message); this.name = "AuthError"; this.code = code; } }

const PAGE = (title, msg) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:Segoe UI,system-ui,sans-serif;background:#FAF9F6;color:#232323;display:grid;place-items:center;height:100vh;margin:0"><div style="border-top:4px solid #A31621;background:#fff;padding:28px 36px;border-radius:6px;max-width:420px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><h2 style="margin:0 0 8px">${title}</h2><p style="margin:0;color:#5b5b5b">${msg}</p></div></body>`;

class GoogleAuth {
  constructor({ clientId, clientSecret, scopes, allowedDomain, openExternal, vault, fetchImpl, timeoutMs }) {
    this.clientId = clientId; this.clientSecret = clientSecret; this.scopes = scopes; this.domain = allowedDomain;
    this.openExternal = openExternal; this.vault = vault; this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.timeoutMs = timeoutMs || 5 * 60 * 1000; this.access = null;
  }
  get configured() { return !!(this.clientId && this.clientSecret); }

  user() { try { return JSON.parse(this.vault.get("google_profile") || "null"); } catch (e) { return null; } }
  signedIn() { return !!(this.vault.get("google_refresh") && this.user()); }

  async _token(params) {
    const res = await this.fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new AuthError(json.error === "invalid_grant" ? "needs_reauth" : "token", json.error_description || json.error || "Google a refusé la connexion.");
    return json;
  }

  _checkProfile(p) {
    const email = String(p.email || "").toLowerCase();
    if (!p.email_verified || !email.endsWith("@" + this.domain) || (p.hd && String(p.hd).toLowerCase() !== this.domain))
      throw new AuthError("domain", `Seuls les comptes Google @${this.domain} peuvent utiliser AGOA ML.`);
    return { email, name: p.name || email, picture: p.picture || "" };
  }

  /** Ouvre le navigateur, attend le retour de Google, enregistre la session. */
  async signIn() {
    if (!this.configured) throw new AuthError("not_configured", "Identifiants Google absents de cette version (resources/google-client.json).");
    const { verifier, challenge } = pkcePair(), state = b64url(crypto.randomBytes(16));
    let server, timer;
    const done = new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://127.0.0.1");
        if (u.pathname !== "/callback") { res.writeHead(404); res.end(); return; }
        const err = u.searchParams.get("error"), code = u.searchParams.get("code");
        if (u.searchParams.get("state") !== state) { res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }); res.end(PAGE("Connexion refusée", "Requête inattendue.")); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        if (err || !code) { res.end(PAGE("Connexion annulée", "Vous pouvez fermer cet onglet et revenir à AGOA ML.")); reject(new AuthError("cancelled", "Connexion annulée.")); return; }
        res.end(PAGE("Connexion réussie", "Vous pouvez fermer cet onglet et revenir à AGOA ML."));
        resolve(code);
      });
      server.on("error", reject);
      timer = setTimeout(() => reject(new AuthError("timeout", "Délai dépassé : connexion Google non terminée.")), this.timeoutMs);
    });
    await new Promise((r, j) => { server.once("error", j); server.listen(0, "127.0.0.1", r); });
    const redirect = `http://127.0.0.1:${server.address().port}/callback`;
    try {
      const q = new URLSearchParams({
        client_id: this.clientId, redirect_uri: redirect, response_type: "code", scope: this.scopes.join(" "),
        code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent", hd: this.domain
      });
      await this.openExternal(`${AUTH_URL}?${q}`);
      const code = await done;
      const tok = await this._token({ code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier });
      const profile = this._checkProfile(decodeIdToken(tok.id_token));
      if (!tok.refresh_token) throw new AuthError("token", "Google n’a pas fourni de session durable. Réessayez.");
      if (tok.scope && !String(tok.scope).includes("gmail.modify"))
        throw new AuthError("scope", "Le droit de lire et modifier les e-mails n’a pas été accordé. Recommencez et cochez TOUTES les cases sur l’écran Google.");
      profile.canSend = String(tok.scope || "").includes("gmail.send");
      this.vault.set("google_refresh", tok.refresh_token);
      this.vault.set("google_profile", JSON.stringify(profile));
      this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
      return profile;
    } finally { clearTimeout(timer); server.close(); }
  }

  async accessToken() {
    if (this.access && this.access.exp > Date.now()) return this.access.token;
    const refresh = this.vault.get("google_refresh");
    if (!refresh) throw new AuthError("needs_reauth", "Connectez-vous à Google.");
    let tok;
    try { tok = await this._token({ client_id: this.clientId, client_secret: this.clientSecret, refresh_token: refresh, grant_type: "refresh_token" }); }
    catch (e) {
      if (e.code === "needs_reauth") {   // session refusée par Google : on l'oublie pour proposer une nouvelle connexion (et ne pas la reprendre du lanceur)
        this.vault.set("google_rejected", refresh); this.vault.remove("google_refresh"); this.vault.remove("google_profile"); this.access = null;
        throw new AuthError("needs_reauth", "La session Google est expirée ou a été révoquée : reconnectez-vous.");
      }
      throw e;
    }
    this.access = { token: tok.access_token, exp: Date.now() + (tok.expires_in - 60) * 1000 };
    return this.access.token;
  }

  /** Oublie la session actuelle (refusée ou insuffisante) sans la reprendre du lanceur. */
  forget() {
    const r = this.vault.get("google_refresh");
    if (r) this.vault.set("google_rejected", r);
    this.vault.remove("google_refresh"); this.vault.remove("google_profile"); this.access = null;
  }

  async signOut() {
    const refresh = this.vault.get("google_refresh");
    this.vault.remove("google_refresh"); this.vault.remove("google_profile"); this.access = null;
    if (refresh) { try { await this.fetch(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }).toString() }); } catch (e) { /* sans importance */ } }
  }

  async sendMail({ to, subject, body }) {
    const p = this.user();
    if (p && p.canSend === false) throw new AuthError("scope", "L’autorisation d’envoyer des courriels n’a pas été accordée : reconnectez-vous à Google et cochez-la.");
    const token = await this.accessToken();
    const res = await this.fetch(GMAIL_SEND, {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: b64url(Buffer.from(buildMime({ to, subject, body }), "utf8")) })
    });
    if (res.status === 401) { this.access = null; throw new AuthError("needs_reauth", "Session Google expirée : reconnectez-vous."); }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new AuthError("send", (j.error && j.error.message) || "Gmail a refusé l’envoi."); }
    return res.json();
  }
}

function buildMime({ to, subject, body }) {
  const rcpt = Array.isArray(to) ? to.join(", ") : to;
  const b64 = Buffer.from(String(body).replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `To: ${rcpt}`,
    `Subject: =?UTF-8?B?${Buffer.from(String(subject), "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    b64
  ].join("\r\n");
}

module.exports = { GoogleAuth, AuthError, buildMime, decodeIdToken, pkcePair, b64url };
