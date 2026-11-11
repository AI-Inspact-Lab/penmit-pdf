// Penmit PDF for Windows and Linux: the web app in an Electron window.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, safeStorage, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const http = require("node:http");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

// The app is served from app://penmit/ so it gets a real, secure origin
// (IndexedDB, crypto.subtle, module workers) without a local web server.
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const WEB_ROOT = app.isPackaged ? path.join(__dirname, "app") : path.join(__dirname, "..", "web");
let win = null;
let pendingFiles = [];

function pdfArgs(argv) {
  return argv.filter((a) => /\.pdf$/i.test(a) && !a.startsWith("-"));
}

async function readPdfs(paths) {
  const out = [];
  for (const p of paths) {
    try {
      out.push({ name: path.basename(p), bytes: new Uint8Array(await fs.readFile(p)) });
    } catch { /* unreadable file: skip */ }
  }
  return out;
}

async function sendFiles(paths) {
  if (!paths.length) return;
  const files = await readPdfs(paths);
  if (!files.length) return;
  if (win && !win.webContents.isLoading()) win.webContents.send("open-files", files);
  else pendingFiles.push(...files);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 480,
    minHeight: 480,
    title: "Penmit PDF",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17181c" : "#ffffff",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadURL("app://penmit/index.html");

  // Links (e.g. "Create a token") open in the user's browser; the window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://penmit/")) {
      e.preventDefault();
      if (url.startsWith("https://")) shell.openExternal(url);
    }
  });
  win.webContents.on("did-finish-load", () => {
    if (pendingFiles.length) {
      win.webContents.send("open-files", pendingFiles);
      pendingFiles = [];
    }
  });
  win.on("closed", () => { win = null; });
}

// ---------- Google sign-in (Google Drive storage) ----------
// Google blocks sign-in inside embedded browsers, so the system browser is used with a
// loopback redirect and PKCE (OAuth 2.0 for installed apps). The client comes from
// google-oauth.json, which the release workflow writes from repository secrets; it is never
// committed. The refresh token is encrypted with the OS keychain (safeStorage) when available.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_CLIENT = (() => {
  try {
    const c = require("./google-oauth.json");
    return c.client_id && c.client_secret ? c : null;
  } catch { return null; }
})();
const tokenFile = () => path.join(app.getPath("userData"), "google-token.bin");
let access = null; // { token, exp }

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function saveRefreshToken(refresh) {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(refresh) : Buffer.from(`plain:${refresh}`);
  await fs.writeFile(tokenFile(), data, { mode: 0o600 });
}

async function loadRefreshToken() {
  try {
    const data = await fs.readFile(tokenFile());
    if (data.subarray(0, 6).toString() === "plain:") return data.subarray(6).toString();
    return safeStorage.decryptString(data);
  } catch { return null; }
}

async function tokenRequest(params) {
  const res = await net.fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT.client_id, client_secret: GOOGLE_CLIENT.client_secret, ...params }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `HTTP ${res.status}`);
  return data;
}

function keep(data) {
  access = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return access.token;
}

const PAGE = (message) => `<!doctype html><meta charset="utf-8"><title>Penmit PDF</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;color:#1b2230"><p style="font-size:1.1rem">${message}</p></body>`;

async function googleSignIn() {
  if (!GOOGLE_CLIENT) throw new Error("Google sign-in is not configured in this build");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  try {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: GOOGLE_CLIENT.client_id, redirect_uri: redirectUri, response_type: "code",
      scope: DRIVE_SCOPE, code_challenge: challenge, code_challenge_method: "S256",
      state, access_type: "offline", prompt: "consent",
    }).toString();
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5 * 60_000);
      server.on("request", (req, res) => {
        const u = new URL(req.url, redirectUri);
        if (u.pathname !== "/") { res.writeHead(404).end(); return; }
        const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE(ok ? "Penmit PDF에 로그인했어요. 이 창을 닫고 앱으로 돌아가세요. / Signed in. You can close this tab." : "로그인하지 못했어요. / Sign-in failed."));
        clearTimeout(timer);
        if (ok) resolve(u.searchParams.get("code")); else reject(new Error(u.searchParams.get("error") || "state mismatch"));
      });
      shell.openExternal(url.toString());
    });
    const data = await tokenRequest({ code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
    if (data.refresh_token) await saveRefreshToken(data.refresh_token);
    keep(data);
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    return true;
  } finally {
    server.close();
  }
}

async function googleToken() {
  if (access && access.exp - 60_000 > Date.now()) return access.token;
  const refresh = await loadRefreshToken();
  if (!refresh || !GOOGLE_CLIENT) throw new Error("signed out");
  return keep(await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" }));
}

async function googleSignOut() {
  const refresh = await loadRefreshToken();
  access = null;
  await fs.rm(tokenFile(), { force: true });
  if (refresh) {
    try { await net.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: "POST" }); } catch { /* offline */ }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    sendFiles(pdfArgs(argv));
  });

  app.whenReady().then(() => {
    protocol.handle("app", (req) => {
      const { pathname } = new URL(req.url);
      const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
      const file = path.normalize(path.join(WEB_ROOT, rel));
      if (!file.startsWith(WEB_ROOT + path.sep)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    });

    ipcMain.handle("save-file", async (_e, { name, bytes }) => {
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: name,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (canceled || !filePath) return false;
      await fs.writeFile(filePath, Buffer.from(bytes));
      return true;
    });

    // Google: only the app's own page may ask, and requests go only to the Drive API.
    const fromApp = (e) => {
      if (!e.senderFrame?.url.startsWith("app://penmit/")) throw new Error("Not allowed");
    };
    ipcMain.handle("google-available", () => Boolean(GOOGLE_CLIENT));
    ipcMain.handle("google-sign-in", (e) => { fromApp(e); return googleSignIn(); });
    ipcMain.handle("google-token", (e) => { fromApp(e); return googleToken(); });
    ipcMain.handle("google-invalidate", () => { access = null; });
    ipcMain.handle("google-sign-out", (e) => { fromApp(e); return googleSignOut(); });
    ipcMain.handle("google-fetch", async (e, { url, method = "GET", headers = {}, body = null }) => {
      fromApp(e);
      const u = new URL(url);
      if (u.protocol !== "https:" || u.hostname !== "www.googleapis.com") throw new Error("Only Google Drive requests are allowed");
      const res = await net.fetch(u.toString(), { method, headers, body: body ? Buffer.from(body) : undefined, cache: "no-store" });
      const out = {};
      for (const name of ["content-type", "location"]) {
        const v = res.headers.get(name);
        if (v) out[name] = v;
      }
      return { status: res.status, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
    });

    createWindow();
    sendFiles(pdfArgs(process.argv.slice(1)));
  });

  app.on("window-all-closed", () => app.quit());
}
