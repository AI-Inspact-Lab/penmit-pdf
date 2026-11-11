// Google sign-in, limited to the drive.file scope: the app sees only the files it created.
//
// Web: OAuth 2.0 for client-side apps. A pop-up goes to Google and comes back to this page
//      with a one-hour access token in the address fragment; the pop-up hands it to the main
//      window through BroadcastChannel/localStorage (Google's pages cut window.opener).
//      Home-screen apps on iPhone/iPad, or a blocked pop-up, use a full-page redirect instead.
// Desktop: the Electron main process signs in through the system browser (loopback + PKCE)
//      and keeps a refresh token, so there is no hourly sign-in (see desktop/main.js).
// Android: Google blocks sign-in inside app web views; a native sign-in comes later.
import { GOOGLE_WEB_CLIENT_ID } from "./config.js";
import { isDesktop, isAndroidApp } from "./platform.js";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_KEY = "penmit.google.token";
const PENDING_KEY = "penmit.google.pending";
const RESULT_KEY = "penmit.google.result";
const CHANNEL = "penmit-google";

export class NeedsGoogleSignIn extends Error {}

function save(key, value) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
function load(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
const randomState = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

function authUrl(state) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: GOOGLE_WEB_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: DRIVE_SCOPE,
    include_granted_scopes: "true",
    state,
  }).toString();
  return u.toString();
}

export const googleAuth = {
  // Whether Google Drive can be used on this platform at all.
  async available() {
    if (isAndroidApp) return false;
    if (isDesktop) return Boolean(await window.penmitDesktop.google?.available());
    return Boolean(GOOGLE_WEB_CLIENT_ID);
  },

  async token() {
    if (isDesktop) {
      try { return await window.penmitDesktop.google.token(); } catch (e) { throw new NeedsGoogleSignIn(e.message); }
    }
    const t = load(TOKEN_KEY);
    if (t && t.exp - 60_000 > Date.now()) return t.token;
    throw new NeedsGoogleSignIn();
  },

  async signedIn() {
    try { await this.token(); return true; } catch { return false; }
  },

  invalidate() {
    if (isDesktop) window.penmitDesktop.google.invalidate?.();
    else save(TOKEN_KEY, null);
  },

  // Call straight from a click handler: browsers allow pop-ups only as a direct result of a click.
  signIn({ after = null } = {}) {
    if (isDesktop) return window.penmitDesktop.google.signIn();
    const state = randomState();
    const popup = standalone() ? null : window.open(authUrl(state), "penmit-google", "popup,width=500,height=650");
    if (!popup) {
      save(PENDING_KEY, { state, mode: "redirect", after, time: Date.now() });
      location.assign(authUrl(state));
      return new Promise(() => {}); // the page is leaving
    }
    save(PENDING_KEY, { state, mode: "popup", time: Date.now() });
    return new Promise((resolve, reject) => {
      let bc = null;
      const finish = (r) => {
        clearTimeout(timer);
        window.removeEventListener("storage", onStorage);
        bc?.close();
        save(RESULT_KEY, null);
        if (r.error) reject(new Error(r.error)); else resolve(true);
      };
      const onStorage = (e) => {
        if (e.key !== RESULT_KEY || !e.newValue) return;
        const r = JSON.parse(e.newValue);
        if (r.state === state) finish(r);
      };
      window.addEventListener("storage", onStorage);
      try {
        bc = new BroadcastChannel(CHANNEL);
        bc.onmessage = (e) => { if (e.data?.state === state) finish(e.data); };
      } catch { /* BroadcastChannel unsupported: the storage event still works */ }
      const timer = setTimeout(() => finish({ error: "timeout" }), 5 * 60_000);
    });
  },

  // Runs first on every page load: picks up a token coming back from Google.
  // Returns null (nothing to do), { popup: true } (this window was the pop-up), or
  // { redirect: true, ok, after } (the whole page went to Google and came back).
  handleReturn() {
    const hash = location.hash.slice(1);
    if (!/(^|&)(access_token|error)=/.test(hash)) return null;
    const p = new URLSearchParams(hash);
    history.replaceState(null, "", location.pathname + location.search);
    const pending = load(PENDING_KEY);
    if (!pending || p.get("state") !== pending.state) return { redirect: true, ok: false };
    save(PENDING_KEY, null);
    const result = p.get("access_token")
      ? { state: pending.state, ok: true }
      : { state: pending.state, error: p.get("error") || "access_denied" };
    if (p.get("access_token")) {
      save(TOKEN_KEY, { token: p.get("access_token"), exp: Date.now() + Number(p.get("expires_in") || 3600) * 1000 });
    }
    if (pending.mode === "popup") {
      try { const bc = new BroadcastChannel(CHANNEL); bc.postMessage(result); bc.close(); } catch { /* ignore */ }
      save(RESULT_KEY, result);
      window.close();
      return { popup: true };
    }
    return { redirect: true, ok: !result.error, after: pending.after };
  },

  async signOut() {
    if (isDesktop) return window.penmitDesktop.google.signOut();
    const t = load(TOKEN_KEY);
    save(TOKEN_KEY, null);
    if (t?.token) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.token)}`, { method: "POST", mode: "no-cors" });
      } catch { /* offline: the token expires within the hour anyway */ }
    }
  },
};
