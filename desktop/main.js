// Penmit PDF for Windows and Linux: the web app in an Electron window.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
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
    backgroundColor: "#eef0f4",
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

    createWindow();
    sendFiles(pdfArgs(process.argv.slice(1)));
  });

  app.on("window-all-closed", () => app.quit());
}
