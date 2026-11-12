// Offline support for the web app.
//
// The app's own files are fetched fresh whenever the device is online (revalidated, so usually a
// quick "not modified"), and the cache is only the fallback when offline. A new version therefore
// always arrives whole; serving cached code first used to mix a new page with old code right
// after an update. Third-party files under vendor/ don't change between versions and come from
// the cache. Google Drive and GitHub requests are never touched.
const VERSION = "penmit-0.5.1";
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
  // "reload" skips the browser's HTTP cache, so the new version's files are cached, not old copies.
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fresh(req, key) {
  const cache = await caches.open(VERSION);
  try {
    let res = await fetch(req.mode === "navigate" ? req.url : req, { cache: "no-cache", credentials: "same-origin" });
    if (res.redirected) res = await fetch(req); // let the browser handle redirects itself
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw e;
  }
}

async function cached(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (req.mode === "navigate") event.respondWith(fresh(req, "index.html"));
  else if (url.pathname.includes("/vendor/")) event.respondWith(cached(req));
  else event.respondWith(fresh(req, req));
});
