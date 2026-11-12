// Offline support for the web app: the app itself is cached; Google Drive and GitHub calls always go to the network.
const VERSION = "penmit-0.3.1";
const CORE = [
  "./",
  "index.html",
  "app.css",
  "manifest.webmanifest",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "src/main.js",
  "src/i18n.js",
  "src/db.js",
  "src/viewer.js",
  "src/ink.js",
  "src/export.js",
  "src/github.js",
  "src/gdrive.js",
  "src/googleauth.js",
  "src/sync.js",
  "src/config.js",
  "src/platform.js",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "vendor/pdf-lib/pdf-lib.esm.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Pages: network first so updates arrive, cache when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(VERSION).then((c) => c.put("index.html", copy)); return res; })
        .catch(() => caches.match("index.html")),
    );
    return;
  }
  // Everything else (code, fonts, CMaps): cache first, filled on first use.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
