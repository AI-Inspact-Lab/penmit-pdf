import { t, applyI18n, lang } from "./i18n.js";
import { db, requestPersistence, sha256Hex } from "./db.js";
import { Viewer, openPdf, renderThumbnail, isPasswordError, MIN_ZOOM, MAX_ZOOM } from "./viewer.js";
import { Ink, emptyInk, strokesByPage, blankPages, PEN_COLORS, HIGHLIGHT_COLORS, WIDTHS, ERASER_SIZES, drawStroke } from "./ink.js";
import { exportAnnotated, EncryptedPdfError } from "./export.js";
import { GitHub, GitHubBackend } from "./github.js";
import { DriveBackend } from "./gdrive.js";
import { googleAuth, NeedsGoogleSignIn } from "./googleauth.js";
import { sync, mergeInk, sameInk } from "./sync.js";
import { saveFile, registerServiceWorker, isDesktop, isAndroidApp } from "./platform.js";

export const VERSION = "0.5.1";
const $ = (sel) => document.querySelector(sel);

// ---------- settings ----------
const SETTINGS_KEY = "penmit.settings";
function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch { return {}; }
}
const settings = {
  fingerMode: "auto",
  tool: "pen",
  style: null,
  layout: "single",
  sort: "recent",
  lastSync: {},
  github: { owner: "", repo: "", branch: "", token: "" },
  ...readSettings(),
};
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}
// Finger drawing: "auto" draws with a finger until a pen is used on this device, then the
// finger only moves the page (as note apps do once a stylus is paired). "on"/"off" are the
// user's own choice. Older settings had a plain on/off switch that defaulted to off.
if (settings.fingerDraw === true && !readSettings().fingerMode) settings.fingerMode = "on";
delete settings.fingerDraw;
if (!["auto", "on", "off"].includes(settings.fingerMode)) settings.fingerMode = "auto";
const PEN_SEEN_KEY = "penmit.penSeen";
let penSeen = (() => { try { return localStorage.getItem(PEN_SEEN_KEY) === "1"; } catch { return false; } })();
const fingerDraws = () => settings.fingerMode === "on" || (settings.fingerMode === "auto" && !penSeen);
const githubComplete = () => Boolean(settings.github.owner && settings.github.repo && settings.github.token);
// Where to sync: "none", "gdrive" or "github" (older settings had only GitHub).
if (!settings.storage) settings.storage = githubComplete() ? "github" : "none";
const storageReady = () => (settings.storage === "github" ? githubComplete() : settings.storage === "gdrive");

// ---------- toast ----------
let toastTimer = 0;
function toast(message, { error = false, ms = 3200 } = {}) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("error", error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- views ----------
const viewer = new Viewer($("#scroller"), $("#pages"));
const ink = new Ink(viewer);
ink.setFingerDraw(fingerDraws());
ink.addEventListener("pen", () => {
  if (penSeen) return;
  penSeen = true;
  try { localStorage.setItem(PEN_SEEN_KEY, "1"); } catch { /* storage unavailable */ }
  if (settings.fingerMode === "auto") {
    ink.setFingerDraw(false);
    toast(t("penDetected"), { ms: 4500 });
  }
});
if (settings.style) {
  for (const k of ["pen", "highlighter", "eraser"]) if (settings.style[k]) ink.style[k] = { ...ink.style[k], ...settings.style[k] };
}
ink.setTool(settings.tool || "pen");

let current = null; // { id, doc, bytes }

function show(view) {
  closeMenu();
  $("#library").hidden = view !== "library";
  $("#reader").hidden = view !== "reader";
}

// ---------- icons used in menus ----------
const ICON = {
  check: '<svg class="i check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  more: '<svg class="i sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>',
  rename: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5l1-4L16 5a2 2 0 0 1 2.8 0l.2.2a2 2 0 0 1 0 2.8L8.5 18.5z"/><path d="M13 20h7"/></svg>',
  export: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M8 7.5l4-4 4 4"/><path d="M8.5 10.5H6.5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-8.5a1 1 0 0 0-1-1h-2"/></svg>',
  trash: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>',
};

// ---------- pop-up menus ----------
let openMenuEl = null;
let menuAnchor = null;
function closeMenu() {
  if (!openMenuEl) return;
  if (openMenuEl.dataset.dynamic) openMenuEl.remove(); else openMenuEl.hidden = true;
  menuAnchor?.setAttribute("aria-expanded", "false");
  openMenuEl = null;
  menuAnchor = null;
}
function showMenu(menu, anchor, point = null) {
  closeMenu();
  openMenuEl = menu;
  menuAnchor = anchor;
  anchor?.setAttribute("aria-expanded", "true");
  menu.hidden = false;
  const r = point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.min(Math.max(8, point ? r.left : r.right - w), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
function buildMenu(items) {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  menu.dataset.dynamic = "1";
  for (const it of items) {
    if (it === "-") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      menu.append(sep);
      continue;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = `menu-item${it.danger ? " danger" : ""}`;
    b.setAttribute("role", it.checked === undefined ? "menuitem" : "menuitemradio");
    if (it.action) b.dataset.action = it.action;
    b.innerHTML = it.icon || "";
    const label = document.createElement("span");
    label.textContent = it.label;
    b.append(label);
    if (it.checked !== undefined) {
      b.setAttribute("aria-checked", String(it.checked));
      b.insertAdjacentHTML("beforeend", ICON.check);
    }
    b.addEventListener("click", () => { closeMenu(); it.run(); });
    menu.append(b);
  }
  menu.hidden = true;
  document.body.append(menu);
  return menu;
}
function toggleMenu(menuOrItems, anchor) {
  if (openMenuEl && menuAnchor === anchor) { closeMenu(); return; }
  showMenu(Array.isArray(menuOrItems) ? buildMenu(menuOrItems) : menuOrItems, anchor);
}
document.addEventListener("pointerdown", (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu();
}, true);
window.addEventListener("resize", closeMenu);

// ---------- library ----------
const SORTS = {
  recent: { label: "sortRecent", cmp: (a, b) => (b.openedAt || b.addedAt || 0) - (a.openedAt || a.addedAt || 0) },
  name: { label: "sortName", cmp: (a, b) => a.name.localeCompare(b.name, lang, { numeric: true, sensitivity: "base" }) },
  added: { label: "sortAdded", cmp: (a, b) => (b.addedAt || 0) - (a.addedAt || 0) },
};
if (!SORTS[settings.sort]) settings.sort = "recent";

function dayLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return t("today");
  if (diff === 1) return t("yesterday");
  return t("date", d, d.getFullYear() === now.getFullYear());
}

function docTile(d) {
  const li = document.createElement("li");
  li.className = "doc";
  li.dataset.id = d.id;
  const open = document.createElement("button");
  open.type = "button";
  open.className = "doc-open";
  open.setAttribute("aria-label", d.name);
  const thumb = document.createElement("div");
  thumb.className = "doc-thumb";
  if (d.thumb) {
    const img = new Image();
    img.alt = "";
    img.src = d.thumb;
    thumb.append(img);
  } else {
    thumb.innerHTML = '<div class="ph"></div>';
  }
  open.append(thumb);
  open.addEventListener("click", () => openDoc(d.id));

  const info = document.createElement("div");
  info.className = "doc-info";
  const text = document.createElement("div");
  text.className = "doc-text";
  const name = document.createElement("p");
  name.className = "doc-name";
  name.textContent = d.name;
  const meta = document.createElement("p");
  meta.className = "doc-meta";
  meta.textContent = [dayLabel(d.openedAt || d.addedAt), d.pageCount ? t("pages", d.pageCount) : ""].filter(Boolean).join(" · ");
  text.append(name, meta);
  text.addEventListener("click", () => openDoc(d.id));
  const more = document.createElement("button");
  more.type = "button";
  more.className = "doc-more";
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-label", `${t("more")}: ${d.name}`);
  more.innerHTML = ICON.more;
  more.addEventListener("click", () => toggleMenu(docMenuItems(d), more));
  info.append(text, more);
  li.append(open, info);
  li.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(buildMenu(docMenuItems(d)), more, { x: e.clientX, y: e.clientY });
  });
  return li;
}

function docMenuItems(d) {
  return [
    { label: t("rename"), icon: ICON.rename, action: "rename", run: () => renameDoc(d) },
    { label: t("exportDoc"), icon: ICON.export, action: "export", run: () => exportDoc(d.id) },
    "-",
    { label: t("deleteDoc"), icon: ICON.trash, action: "delete", danger: true, run: () => deleteDoc(d) },
  ];
}

async function renderLibrary() {
  const all = (await db.getAll("docs")).filter((d) => !d.deleted);
  const query = $("#search").value.trim();
  const q = query.toLowerCase();
  const docs = all.filter((d) => !q || d.name.toLowerCase().includes(q)).sort(SORTS[settings.sort].cmp);
  const list = $("#doc-list");
  list.querySelectorAll(".doc").forEach((el) => el.remove());
  const empty = all.length === 0;
  $("#lib-empty").hidden = !empty;
  list.hidden = empty;
  $("#lib-tools").hidden = empty;
  $("#empty-sync").hidden = !storageReady();
  $("#no-results").hidden = empty || docs.length > 0;
  if (!empty && !docs.length) $("#no-results").textContent = t("noResults", query);
  $("#sort-label").textContent = t(SORTS[settings.sort].label);
  for (const d of docs) list.append(docTile(d));
  for (const d of docs) if (!d.thumb) ensureThumb(d);
}

$("#search").addEventListener("input", () => renderLibrary());
$("#sort-btn").addEventListener("click", () => toggleMenu(Object.entries(SORTS).map(([key, s]) => ({
  label: t(s.label),
  checked: settings.sort === key,
  run: () => { settings.sort = key; saveSettings(); renderLibrary(); },
})), $("#sort-btn")));
$("#lib-main").addEventListener("scroll", (e) => {
  $(".lib-header").classList.toggle("scrolled", e.target.scrollTop > 2);
}, { passive: true });

// Where the library is synced, and when it last was.
function agoLabel(ts) {
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return t("lineJustNow");
  if (min < 60) return t("lineMinutes", min);
  const h = Math.floor(min / 60);
  if (h < 24) return t("lineHours", h);
  return t("lineDate", dayLabel(ts));
}
function updateSyncLine() {
  const el = $("#sync-line");
  if (!storageReady()) {
    el.textContent = t("lineNone");
    el.dataset.state = "off";
    return;
  }
  const where = settings.storage === "gdrive" ? t("lineDrive") : `${t("lineGitHub")} · ${settings.github.owner}/${settings.github.repo}`;
  const last = settings.lastSync?.[settings.storage];
  el.dataset.state = syncProblem ? "error" : last ? "ok" : "never";
  el.textContent = `${where} · ${syncProblem || (last ? agoLabel(last) : t("lineNever"))}`;
}
setInterval(updateSyncLine, 60_000);

const renameDialog = $("#rename");
const renameInput = $("#rename-form").elements.namedItem("name");
let renaming = null;
function renameDoc(d) {
  renaming = d;
  renameInput.value = d.name;
  renameDialog.returnValue = "";
  renameDialog.showModal();
  const dot = d.name.toLowerCase().endsWith(".pdf") ? d.name.length - 4 : d.name.length;
  renameInput.setSelectionRange(0, dot);
}
renameDialog.addEventListener("close", async () => {
  const d = renaming;
  renaming = null;
  const name = renameInput.value.trim();
  if (renameDialog.returnValue !== "ok" || !d || !name || name === d.name) return;
  const fresh = (await db.get("docs", d.id)) || d;
  await db.put("docs", { ...fresh, name, updatedAt: Date.now() });
  await renderLibrary();
  toast(t("renamed"));
  markDirty();
});

async function ensureThumb(d) {
  const file = await db.get("files", d.id);
  if (!file) return;
  try {
    const pdf = await openPdf(file.bytes);
    const thumb = await renderThumbnail(pdf);
    const fresh = (await db.get("docs", d.id)) || d;
    await db.put("docs", { ...fresh, thumb, pageCount: fresh.pageCount || pdf.numPages });
    await pdf.destroy();
    const box = document.querySelector(`.doc[data-id="${d.id}"] .doc-thumb`);
    if (box) { box.innerHTML = ""; const img = new Image(); img.alt = ""; img.src = thumb; box.append(img); }
  } catch (e) {
    console.warn("thumbnail", e);
  }
}

async function importFiles(fileList) {
  const files = [...fileList];
  let added = 0;
  let lastId = null;
  for (const file of files) {
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) { toast(t("notPdf", file.name), { error: true }); continue; }
    const bytes = await file.arrayBuffer();
    const id = await sha256Hex(bytes);
    const existing = await db.get("docs", id);
    if (existing && !existing.deleted) { toast(t("alreadyAdded", existing.name)); lastId = id; continue; }
    let pdf;
    try {
      pdf = await openPdf(bytes);
    } catch (e) {
      toast(isPasswordError(e) ? t("passwordPdf") : t("openFailed", e.message), { error: true });
      continue;
    }
    const thumb = await renderThumbnail(pdf).catch(() => null);
    const now = Date.now();
    await db.put("files", { id, bytes });
    await db.put("ink", emptyInk(id));
    // synced: null even when re-adding a deleted file, so its notes on GitHub are merged back in.
    await db.put("docs", { id, name: file.name, size: bytes.byteLength, pageCount: pdf.numPages, addedAt: now, updatedAt: now, openedAt: now, thumb, synced: null });
    await pdf.destroy();
    added++;
    lastId = id;
  }
  if (added) { toast(t("added", added)); requestPersistence(); markDirty(); }
  await renderLibrary();
  if (files.length === 1 && lastId) await openDoc(lastId);
}

async function deleteDoc(d) {
  if (!confirm(t("confirmDelete", d.name))) return;
  await db.del("files", d.id);
  await db.del("ink", d.id);
  // Keep a marker for synced files so the next sync removes them from GitHub too.
  if (d.synced) await db.put("docs", { id: d.id, name: d.name, deleted: true, synced: d.synced });
  else await db.del("docs", d.id);
  await renderLibrary();
  markDirty();
}

// ---------- reader ----------
async function openDoc(id) {
  const d = await db.get("docs", id);
  const file = await db.get("files", id);
  if (!d || !file) return;
  let pdf;
  try {
    pdf = await openPdf(file.bytes);
  } catch (e) {
    toast(isPasswordError(e) ? t("passwordPdf") : t("openFailed", e.message), { error: true });
    return;
  }
  current = { id, doc: d, bytes: file.bytes };
  show("reader");
  $("#doc-title").textContent = d.name;
  document.title = `${d.name} · Penmit PDF`;
  const view = d.view || {};
  const model = (await db.get("ink", id)) || emptyInk(id);
  await viewer.load(pdf, { layout: view.layout || settings.layout, zoom: view.zoom || 1, page: view.page || 0, blanks: blankPages(model) });
  ink.setModel(model);
  closePanel();
  syncLayoutButtons();
  syncZoomLabel();
  syncPageIndicator(viewer.currentPage());
  flashPageIndicator();
  syncHistoryButtons();
  await db.put("docs", { ...d, openedAt: Date.now(), pageCount: d.pageCount || pdf.numPages });
}

async function closeDoc() {
  if (!current) return;
  exitFullscreen();
  closePanel();
  await flushInk();
  const d = (await db.get("docs", current.id)) || current.doc;
  await db.put("docs", { ...d, view: { layout: viewer.layout, zoom: viewer.zoom, page: viewer.currentPage() } });
  viewer.clear();
  ink.model = null;
  current = null;
  document.title = "Penmit PDF";
  show("library");
  await renderLibrary();
  if (autoSyncOn() && inkDirty) runSync({ quiet: true });
  else reloadIfUpdated();
}

// Save handwriting shortly after each change, and right away when the app is hidden.
let saveTimer = 0;
let inkDirty = false;
ink.addEventListener("change", () => {
  markDirty();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushInk, 400);
  scheduleThumbRefresh();
});
ink.addEventListener("pages", () => {
  viewer.setBlankPages(blankPages(ink.model), ink.focusKey);
  syncPageIndicator(viewer.currentPage());
  if (panelOpen) renderThumbs();
});
ink.addEventListener("selection", renderSelectionBar);
ink.addEventListener("history", syncHistoryButtons);
async function flushInk() {
  clearTimeout(saveTimer);
  if (current && ink.model) await db.put("ink", ink.model);
}
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) {
    await flushInk();
    // Leaving the app: send unsynced changes now (best effort).
    if (autoSyncOn() && inkDirty && !syncing) runSync({ quiet: true });
  } else if (autoSyncOn() && Date.now() - (settings.lastSync?.[settings.storage] || 0) > 60_000) {
    scheduleAutoSync(800);
  }
});
window.addEventListener("pagehide", () => { flushInk(); });
window.addEventListener("online", () => { if (inkDirty) scheduleAutoSync(1500); });

function syncHistoryButtons() {
  $("#fs-undo").disabled = !ink.canUndo;
  $("#undo").disabled = !ink.canUndo;
  $("#redo").disabled = !ink.canRedo;
}

function syncLayoutButtons() {
  for (const b of document.querySelectorAll("[data-layout]")) b.setAttribute("aria-checked", String(b.dataset.layout === viewer.layout));
}
function syncZoomLabel() { $("#zoom-fit").textContent = `${Math.round(viewer.zoom * 100)}%`; }
function syncPageIndicator(i) { $("#page-ind").textContent = viewer.pages.length ? `${i + 1} / ${viewer.pages.length}` : ""; }

// The page number shows while the pages move, then fades.
let pageIndTimer = 0;
function flashPageIndicator() {
  const el = $("#page-ind");
  el.classList.add("show");
  clearTimeout(pageIndTimer);
  pageIndTimer = setTimeout(() => el.classList.remove("show"), 1400);
}
viewer.addEventListener("pagechange", (e) => { syncPageIndicator(e.detail); flashPageIndicator(); });
$("#scroller").addEventListener("scroll", flashPageIndicator, { passive: true });
$("#view-btn").addEventListener("click", () => toggleMenu($("#view-menu"), $("#view-btn")));

// ---------- full screen ----------
// Only the pages, each row (two pages in the two-page layouts) fitted to the screen and
// moved one at a time. A pen writes; a finger turns the pages (swipe, or tap near an edge).
let fullscreen = null; // { zoom, browser }
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
function enterFullscreen() {
  if (fullscreen || !current) return;
  closeMenu();
  fullscreen = { zoom: viewer.zoom, browser: false };
  $("#reader").classList.add("fullscreen");
  if (ink.tool === "hand") selectTool("pen");
  ink.setFingerDraw(false);
  viewer.zoom = 1;
  viewer.setFitMode("page");
  syncHistoryButtons();
  const root = document.documentElement;
  const request = root.requestFullscreen?.bind(root) || root.webkitRequestFullscreen?.bind(root);
  try {
    const r = request?.({ navigationUI: "hide" });
    r?.catch?.(() => {});
  } catch { /* not allowed here (iPhone): the app still hides its own bars */ }
}
function exitFullscreen() {
  if (!fullscreen) return;
  const { zoom } = fullscreen;
  fullscreen = null;
  $("#reader").classList.remove("fullscreen", "zoomed");
  ink.setFingerDraw(fingerDraws());
  viewer.zoom = zoom;
  viewer.setFitMode("width");
  if (fsElement()) {
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document)?.catch?.(() => {}); } catch { /* ignore */ }
  }
}
for (const type of ["fullscreenchange", "webkitfullscreenchange"]) {
  document.addEventListener(type, () => {
    if (!fullscreen) return;
    if (fsElement()) fullscreen.browser = true;
    else if (fullscreen.browser) exitFullscreen(); // the browser's own exit (Esc, back gesture)
  });
}
$("#fullscreen").addEventListener("click", enterFullscreen);
$("#fs-exit").addEventListener("click", exitFullscreen);
$("#fs-undo").addEventListener("click", () => ink.undo());
viewer.addEventListener("zoom", () => {
  $("#reader").classList.toggle("zoomed", Boolean(fullscreen) && viewer.zoom > 1.02);
});

// Finger swipes and edge taps turn the pages in full screen. Pointer events tell a finger
// from a pen; a vertical swipe scrolls natively (and is cancelled here).
let swipe = null;
$("#scroller").addEventListener("pointerdown", (e) => {
  swipe = fullscreen && e.pointerType === "touch" && e.isPrimary && !viewer.gesture
    ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() }
    : null;
});
$("#scroller").addEventListener("pointercancel", (e) => { if (swipe?.id === e.pointerId) swipe = null; });
$("#scroller").addEventListener("pointerup", (e) => {
  const s = swipe;
  swipe = null;
  if (!s || s.id !== e.pointerId || !fullscreen || viewer.zoom > 1.02 || viewer.gesture) return;
  const dx = e.clientX - s.x;
  const dy = e.clientY - s.y;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) { viewer.stepRow(dx < 0 ? 1 : -1); return; }
  if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && performance.now() - s.t < 350) {
    const box = $("#scroller").getBoundingClientRect();
    const fx = (e.clientX - box.left) / box.width;
    if (fx < 0.2) viewer.stepRow(-1);
    else if (fx > 0.8) viewer.stepRow(1);
  }
});

// ---------- pages panel: thumbnails, the PDF's contents, blank pages ----------
let panelOpen = false;
let panelTab = "thumbs";
let thumbIO = null;
const narrow = () => window.matchMedia("(max-width: 699px)").matches;
const keyFromString = (s) => (/^\d+$/.test(s) ? Number(s) : s);

function relayoutKeepingPage() {
  if (!viewer.pages.length) return;
  const page = viewer.currentPage();
  viewer.relayout();
  viewer.scrollToPage(page, false);
}
function openPanel() {
  if (panelOpen || !current) return;
  panelOpen = true;
  closeMenu();
  $("#pages-panel").hidden = false;
  $("#reader").classList.add("panel-open");
  $("#pages-btn").setAttribute("aria-expanded", "true");
  if (!narrow()) relayoutKeepingPage();
  renderPanel();
}
function closePanel() {
  if (!panelOpen) return;
  panelOpen = false;
  thumbIO?.disconnect();
  $("#pages-panel").hidden = true;
  $("#reader").classList.remove("panel-open");
  $("#pages-btn").setAttribute("aria-expanded", "false");
  if (current && !narrow()) relayoutKeepingPage();
}
$("#pages-btn").addEventListener("click", () => (panelOpen ? closePanel() : openPanel()));
$("#pp-close").addEventListener("click", closePanel);
for (const tab of document.querySelectorAll("[data-pp]")) {
  tab.addEventListener("click", () => { panelTab = tab.dataset.pp; renderPanel(); });
}
function renderPanel() {
  for (const tab of document.querySelectorAll("[data-pp]")) tab.setAttribute("aria-selected", String(tab.dataset.pp === panelTab));
  $("#thumbs").hidden = panelTab !== "thumbs";
  $("#outline").hidden = panelTab !== "outline";
  $("#add-blank").parentElement.hidden = panelTab !== "thumbs";
  if (panelTab === "thumbs") renderThumbs(); else renderOutline();
}
function goToPageFromPanel(index) {
  viewer.scrollToPage(index, false);
  if (narrow()) closePanel();
}

const MORE_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18" cy="12" r="1.3"/></svg>';
function thumbMenu(p) {
  const items = [{ label: t("addBlankAfter"), action: "add-blank", run: () => addBlankAfter(p.key) }];
  if (p.blank) {
    items.push("-", {
      label: t("removeBlank"), action: "remove-blank", danger: true,
      run: () => { if (!ink.strokeCount(p.key) || confirm(t("confirmRemoveBlank"))) ink.removeBlankPage(p.key); },
    });
  }
  return items;
}
function renderThumbs() {
  if (!panelOpen || panelTab !== "thumbs") return;
  const list = $("#thumbs");
  list.textContent = "";
  thumbIO?.disconnect();
  thumbIO = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) drawThumb(e.target);
  }, { root: $("#pp-body"), rootMargin: "300px 0px" });
  const cur = viewer.currentPage();
  for (const p of viewer.pages) {
    const li = document.createElement("li");
    li.className = `thumb${p.index === cur ? " current" : ""}`;
    li.dataset.key = String(p.key);
    const open = document.createElement("button");
    open.type = "button";
    open.className = "thumb-btn";
    open.setAttribute("aria-label", p.blank ? `${t("pageLabel", p.index + 1)} (${t("blankLabel")})` : t("pageLabel", p.index + 1));
    const img = document.createElement("div");
    img.className = "thumb-img";
    const canvas = document.createElement("canvas");
    canvas.width = 3;
    canvas.height = 4;
    img.append(canvas);
    open.append(img);
    open.addEventListener("click", () => goToPageFromPanel(p.index));
    const label = document.createElement("div");
    label.className = "thumb-label";
    const num = document.createElement("span");
    num.textContent = String(p.index + 1);
    label.append(num);
    if (p.blank) {
      const small = document.createElement("small");
      small.textContent = ` · ${t("blankLabel")}`;
      label.append(small);
    }
    const more = document.createElement("button");
    more.type = "button";
    more.className = "thumb-more";
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-label", `${t("more")}: ${t("pageLabel", p.index + 1)}`);
    more.innerHTML = MORE_ICON;
    more.addEventListener("click", () => toggleMenu(thumbMenu(p), more));
    label.append(more);
    li.addEventListener("contextmenu", (e) => { e.preventDefault(); showMenu(buildMenu(thumbMenu(p)), more, { x: e.clientX, y: e.clientY }); });
    li.append(open, label);
    list.append(li);
    thumbIO.observe(li);
  }
  list.querySelector(".thumb.current")?.scrollIntoView({ block: "center" });
}
async function drawThumb(li, force = false) {
  if (li.dataset.drawn === "1" && !force) return;
  li.dataset.drawn = "1";
  const p = viewer.byKey.get(keyFromString(li.dataset.key));
  if (!p || !ink.model) return;
  const width = 240;
  const scale = width / p.w;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.max(1, Math.round(p.h * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let T = [scale, 0, 0, -scale, 0, p.h * scale];
  if (!p.blank) {
    const vp = p.proxy.getViewport({ scale });
    T = vp.transform;
    try { await p.proxy.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise; } catch { return; }
  }
  ctx.setTransform(...T);
  for (const s of ink.byPage.get(p.key) || []) drawStroke(ctx, s);
  li.querySelector(".thumb-img canvas")?.replaceWith(canvas);
}
// Keep the thumbnails of the pages being written on up to date.
let thumbTimer = 0;
function scheduleThumbRefresh() {
  if (!panelOpen || panelTab !== "thumbs") return;
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    for (const p of viewer.visible) {
      const li = $(`#thumbs .thumb[data-key="${CSS.escape(String(p.key))}"]`);
      if (li) drawThumb(li, true);
    }
  }, 700);
}
viewer.addEventListener("pagechange", (e) => {
  if (!panelOpen) return;
  for (const li of document.querySelectorAll("#thumbs .thumb")) {
    const p = viewer.byKey.get(keyFromString(li.dataset.key));
    li.classList.toggle("current", p?.index === e.detail);
  }
});

function addBlankAfter(key) {
  const newKey = ink.addBlankPage(key);
  const p = newKey && viewer.byKey.get(newKey);
  if (p) toast(t("blankAdded", p.index + 1));
}
$("#add-blank").addEventListener("click", () => {
  const p = viewer.pages[viewer.currentPage()];
  if (p) addBlankAfter(p.key);
});

async function renderOutline() {
  const box = $("#outline");
  box.textContent = "";
  let items = null;
  try { items = await viewer.pdf?.getOutline(); } catch { items = null; }
  if (!items?.length) {
    const empty = document.createElement("p");
    empty.className = "outline-empty";
    empty.textContent = t("noOutline");
    box.append(empty);
    return;
  }
  const list = (entries) => {
    const ul = document.createElement("ul");
    for (const item of entries) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = item.title || "—";
      b.addEventListener("click", () => goToDest(item.dest));
      li.append(b);
      if (item.items?.length) li.append(list(item.items));
      ul.append(li);
    }
    return ul;
  };
  box.append(list(items));
}
async function goToDest(dest) {
  const pdf = viewer.pdf;
  if (!pdf || !dest) return;
  try {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return;
    const ref = explicit[0];
    const index = typeof ref === "number" ? ref : await pdf.getPageIndex(ref);
    const p = viewer.byKey.get(index);
    if (p) goToPageFromPanel(p.index);
  } catch { /* a broken link in the PDF */ }
}

// ---------- go to page ----------
const gotoDialog = $("#goto");
const gotoInput = $("#goto-form").elements.namedItem("page");
$("#page-ind").addEventListener("click", () => {
  if (!viewer.pages.length) return;
  gotoInput.value = "";
  gotoInput.placeholder = String(viewer.currentPage() + 1);
  $("#goto-range").textContent = t("gotoRange", viewer.pages.length);
  gotoDialog.returnValue = "";
  gotoDialog.showModal();
  gotoInput.focus();
});
gotoDialog.addEventListener("close", () => {
  if (gotoDialog.returnValue !== "ok") return;
  // Accept full-width digits too (handwriting and some keyboards produce them).
  const digits = gotoInput.value.replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)).replace(/\D/g, "");
  const n = parseInt(digits, 10);
  if (!Number.isFinite(n)) return;
  viewer.scrollToPage(Math.min(Math.max(n, 1), viewer.pages.length) - 1, false);
});
viewer.addEventListener("zoom", syncZoomLabel);

for (const b of document.querySelectorAll("[data-layout]")) {
  b.addEventListener("click", () => {
    viewer.setLayout(b.dataset.layout);
    settings.layout = b.dataset.layout;
    saveSettings();
    syncLayoutButtons();
    closeMenu();
  });
}
const ZOOM_STEP = 1.25;
$("#zoom-in").addEventListener("click", () => viewer.setZoom(Math.min(MAX_ZOOM, viewer.zoom * ZOOM_STEP)));
$("#zoom-out").addEventListener("click", () => viewer.setZoom(Math.max(MIN_ZOOM, viewer.zoom / ZOOM_STEP)));
$("#zoom-fit").addEventListener("click", () => viewer.setZoom(1));
$("#back").addEventListener("click", closeDoc);
$("#export").addEventListener("click", exportCurrent);
$("#undo").addEventListener("click", () => ink.undo());
$("#redo").addEventListener("click", () => ink.redo());

// ---------- toolbar ----------
function renderToolbar() {
  const tool = ink.tool;
  for (const b of document.querySelectorAll(".tool[data-tool]")) b.setAttribute("aria-checked", String(b.dataset.tool === tool));
  const bar = $("#toolbar");
  bar.classList.toggle("eraser-mode", tool === "eraser");
  bar.classList.toggle("hand-mode", tool === "hand");
  bar.classList.toggle("lasso-mode", tool === "lasso");
  for (const b of document.querySelectorAll("[data-erase]")) b.setAttribute("aria-checked", String(b.dataset.erase === ink.style.eraser.mode));
  const sizes = $("#eraser-sizes");
  sizes.textContent = "";
  ERASER_SIZES.forEach((_, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "width";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(i === ink.style.eraser.size));
    b.setAttribute("aria-label", `${t("eraserSize")} ${i + 1}`);
    const dot = document.createElement("span");
    dot.style.width = dot.style.height = `${[7, 11, 17][i]}px`;
    b.append(dot);
    b.addEventListener("click", () => { ink.style.eraser.size = i; persistStyle(); renderToolbar(); });
    sizes.append(b);
  });
  const kind = tool === "highlighter" ? "highlighter" : "pen";
  const style = ink.style[kind];
  $(".tool[data-tool=pen] .tool-color").style.setProperty("--c", ink.style.pen.color);
  $(".tool[data-tool=highlighter] .tool-color").style.setProperty("--c", ink.style.highlighter.color);

  const swatches = $("#swatches");
  swatches.textContent = "";
  for (const color of kind === "highlighter" ? HIGHLIGHT_COLORS : PEN_COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(color === style.color));
    b.setAttribute("aria-label", color);
    b.style.setProperty("--c", color);
    b.append(document.createElement("span"));
    b.addEventListener("click", () => { style.color = color; persistStyle(); renderToolbar(); });
    swatches.append(b);
  }
  const widths = $("#widths");
  widths.textContent = "";
  WIDTHS[kind].forEach((w, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "width";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(w === style.width));
    b.setAttribute("aria-label", `${t("thickness")} ${i + 1}`);
    const dot = document.createElement("span");
    const px = [5, 9, 14][i];
    dot.style.width = dot.style.height = `${px}px`;
    b.append(dot);
    b.addEventListener("click", () => { style.width = w; persistStyle(); renderToolbar(); });
    widths.append(b);
  });
}
function persistStyle() {
  settings.style = { pen: ink.style.pen, highlighter: ink.style.highlighter, eraser: ink.style.eraser };
  saveSettings();
}
for (const b of document.querySelectorAll("[data-erase]")) {
  b.addEventListener("click", () => { ink.style.eraser.mode = b.dataset.erase; persistStyle(); renderToolbar(); });
}

// Buttons over a lasso selection: colours, duplicate, delete.
const SEL_ICON = {
  copy: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>',
  trash: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>',
};
function renderSelectionBar() {
  const sel = ink.selection;
  if (!sel) return;
  const bar = sel.bar;
  bar.textContent = "";
  const button = (label, html, run, cls = "") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.title = label;
    b.setAttribute("aria-label", label);
    b.innerHTML = html;
    b.addEventListener("click", run);
    bar.append(b);
    return b;
  };
  PEN_COLORS.forEach((c, i) => {
    const b = button(t("selColor", i + 1), "", () => ink.recolorSelection(i), "sel-color");
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.setProperty("--c", c);
    b.append(dot);
  });
  const sep = document.createElement("span");
  sep.className = "sep";
  bar.append(sep);
  button(t("selDuplicate"), SEL_ICON.copy, () => ink.duplicateSelection(), "sel-duplicate");
  button(t("selDelete"), SEL_ICON.trash, () => ink.deleteSelection(), "sel-delete danger");
}

function selectTool(tool) {
  ink.setTool(tool);
  settings.tool = tool;
  saveSettings();
  renderToolbar();
}
for (const b of document.querySelectorAll(".tool[data-tool]")) b.addEventListener("click", () => selectTool(b.dataset.tool));

// ---------- export ----------
async function exportCurrent() {
  if (!current) return;
  await flushInk();
  await exportPdf(current.bytes, ink.model, current.doc.name);
}
async function exportDoc(id) {
  const d = await db.get("docs", id);
  const file = await db.get("files", id);
  if (!d || !file) return;
  await exportPdf(file.bytes, (await db.get("ink", id)) || emptyInk(id), d.name);
}
async function exportPdf(pdfBytes, model, name) {
  toast(t("exporting"), { ms: 60_000 });
  try {
    const bytes = await exportAnnotated(pdfBytes, strokesByPage(model), blankPages(model));
    const base = name.replace(/\.pdf$/i, "");
    const saved = await saveFile(`${base} (Penmit).pdf`, bytes);
    if (saved !== false) toast(t("exported")); else $("#toast").hidden = true;
  } catch (e) {
    console.error(e);
    toast(e instanceof EncryptedPdfError ? t("encryptedExport") : t("exportFailed", e.message), { error: true });
  }
}

// ---------- sync (GitHub or Google Drive) ----------
const store = {
  listDocs: () => db.getAll("docs"),
  getDoc: (id) => db.get("docs", id),
  getFile: async (id) => (await db.get("files", id)).bytes,
  async getInk(id) {
    if (current?.id === id && ink.model) return ink.model;
    return (await db.get("ink", id)) || emptyInk(id);
  },
  putDoc: (d) => db.put("docs", d),
  putFile: (id, bytes) => db.put("files", { id, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
  async putInk(model) {
    if (current?.id === model.id && ink.model) {
      const merged = mergeInk(ink.model, model);
      if (!sameInk(merged, ink.model)) ink.replaceModel(merged);
      await db.put("ink", ink.model);
    } else {
      await db.put("ink", model);
    }
  },
  async removeDoc(id) {
    if (current?.id === id) { viewer.clear(); ink.model = null; current = null; show("library"); }
    await db.removeDoc(id);
  },
};

let syncing = false;
let updateReady = false;
function reloadIfUpdated() {
  if (updateReady && !current && !syncing && !(autoSyncOn() && inkDirty)) location.reload();
}
let syncProblem = null; // what went wrong in the last automatic sync, shown instead of a toast

// Automatic sync: a little after the last change, when the app comes back, and when it goes
// to the background. Never more often than MIN_GAP, so a GitHub history isn't one commit per stroke.
const AUTO_DELAY = 20_000;
const MIN_GAP = 45_000;
let changeSeq = 0;
let autoTimer = 0;
let lastAuto = 0;
const autoSyncOn = () => settings.autoSync !== false && storageReady();
function markDirty() {
  inkDirty = true;
  changeSeq++;
  scheduleAutoSync();
}
function scheduleAutoSync(delay = AUTO_DELAY) {
  if (!autoSyncOn()) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(autoSync, delay);
}
async function autoSync() {
  if (!autoSyncOn() || !navigator.onLine) return;
  if (syncing || ink.active || ink.xform) { scheduleAutoSync(5_000); return; }
  const wait = MIN_GAP - (Date.now() - lastAuto);
  if (wait > 0) { scheduleAutoSync(wait); return; }
  lastAuto = Date.now();
  await runSync({ quiet: true });
}

function describeError(e, storage = settings.storage) {
  if (e.tooLarge) return t("errTooLarge", e.tooLarge);
  if (e instanceof NeedsGoogleSignIn) return t("googleNeedsSignIn");
  switch (e.status) {
    case 0: return t("errNetwork");
    case 401: return storage === "gdrive" ? t("errDriveAuth") : t("errAuth");
    case 403: return storage === "gdrive" ? t("errDriveForbidden") : t("errForbidden");
    case 404: return storage === "gdrive" ? t("errDriveNotFound") : t("errNotFound");
    case 429: return t("errRate");
    default: return e.message || String(e);
  }
}
function setSyncProblem(problem) {
  syncProblem = problem;
  $("#reader-sync").classList.toggle("attention", Boolean(problem));
  $("#lib-sync").classList.toggle("attention", Boolean(problem));
  updateSyncLine();
}
function setSyncBusy(busy) {
  for (const b of [$("#lib-sync"), $("#reader-sync")]) { b.classList.toggle("spin", busy); b.disabled = busy; }
}
async function runSync({ quiet = false } = {}) {
  if (syncing) return;
  if (!storageReady()) {
    if (!quiet) { toast(t("syncNotSet")); openSettings(); }
    return;
  }
  if (settings.storage === "gdrive" && !(await googleAuth.signedIn())) {
    if (quiet) setSyncProblem(t("lineSignIn"));
    else { toast(t("googleNeedsSignIn")); openSettings(); }
    return;
  }
  const seq = changeSeq;
  const backend = settings.storage === "gdrive" ? new DriveBackend() : new GitHubBackend(settings.github);
  syncing = true;
  setSyncBusy(true);
  if (!quiet) toast(t("syncing"), { ms: 600_000 });
  try {
    await flushInk();
    const stats = await sync(backend, store);
    // Changes made while syncing go out next time.
    if (changeSeq === seq) inkDirty = false; else scheduleAutoSync();
    setSyncProblem(null);
    settings.lastSync = { ...settings.lastSync, [settings.storage]: Date.now() };
    saveSettings();
    updateSyncLine();
    if (!quiet || stats.down || stats.merged) toast(t("syncDone", stats));
    if (!current) await renderLibrary();
  } catch (e) {
    console.error(e);
    if (quiet) setSyncProblem(e instanceof NeedsGoogleSignIn || e.status === 401 && settings.storage === "gdrive" ? t("lineSignIn") : t("lineFailed"));
    else toast(t("syncFailed", describeError(e)), { error: true, ms: 6000 });
  } finally {
    syncing = false;
    setSyncBusy(false);
    reloadIfUpdated();
  }
}
$("#lib-sync").addEventListener("click", () => runSync());
$("#reader-sync").addEventListener("click", () => runSync());

// ---------- settings ----------
const dialog = $("#settings");
const form = $("#settings-form");
function showStoragePanels() {
  const choice = form.storage.value;
  $("#gdrive-panel").hidden = choice !== "gdrive";
  $("#autosync-group").hidden = !choice || choice === "none";
  $("#github-panel").hidden = choice !== "github";
  if (choice === "gdrive") refreshGoogleStatus();
}
async function refreshGoogleStatus() {
  const status = $("#gdrive-status");
  const available = await googleAuth.available();
  $("#gdrive-unavailable").hidden = available;
  $("#gdrive-unavailable").textContent = isAndroidApp ? t("driveUnavailableAndroid") : t("driveUnavailableDesktop");
  $("#gdrive-actions").hidden = !available;
  if (!available) return;
  status.classList.remove("ok", "bad");
  const signedIn = await googleAuth.signedIn();
  $("#google-sign-in").hidden = signedIn;
  $("#google-sign-out").hidden = !signedIn;
  if (!signedIn) { status.textContent = t("googleNotSignedIn"); return; }
  try {
    const user = await new DriveBackend().account();
    status.textContent = t("googleSignedIn", user.emailAddress || user.displayName || "Google");
    status.classList.add("ok");
  } catch (e) {
    status.textContent = describeError(e, "gdrive");
    status.classList.add("bad");
  }
}
function openSettings() {
  const g = settings.github;
  form.owner.value = g.owner;
  form.repo.value = g.repo;
  form.branch.value = g.branch;
  form.token.value = g.token;
  form.storage.value = settings.storage;
  form.fingerDraw.checked = fingerDraws();
  form.autoSync.checked = settings.autoSync !== false;
  $("#github-status").textContent = "";
  $("#version").textContent = VERSION;
  showStoragePanels();
  dialog.showModal();
}
$("#lib-settings").addEventListener("click", openSettings);
for (const r of form.querySelectorAll("input[name=storage]")) r.addEventListener("change", showStoragePanels);
dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "save") return;
  settings.github = {
    owner: form.owner.value.trim(),
    repo: form.repo.value.trim(),
    branch: form.branch.value.trim(),
    token: form.token.value.trim(),
  };
  settings.storage = form.storage.value || "none";
  settings.autoSync = form.autoSync.checked;
  setSyncProblem(null);
  if (autoSyncOn()) scheduleAutoSync(2_000);
  // Keep "auto" unless the switch was actually changed.
  if (form.fingerDraw.checked !== fingerDraws()) settings.fingerMode = form.fingerDraw.checked ? "on" : "off";
  ink.setFingerDraw(fingerDraws());
  saveSettings();
  updateSyncLine();
  if (!current) renderLibrary();
  toast(t("saved"));
});

// Google: sign in straight from the click (browsers only allow pop-ups that a click opens).
$("#google-sign-in").addEventListener("click", () => {
  const status = $("#gdrive-status");
  status.classList.remove("ok", "bad");
  status.textContent = t("googleSigningIn");
  googleAuth.signIn({ after: "settings" }).then(() => {
    settings.storage = "gdrive";
    saveSettings();
    updateSyncLine();
    refreshGoogleStatus();
  }).catch((e) => {
    status.textContent = t("googleSignInFailed", e.message);
    status.classList.add("bad");
  });
});
$("#google-sign-out").addEventListener("click", async () => {
  await googleAuth.signOut();
  refreshGoogleStatus();
});
$("#test-github").addEventListener("click", async () => {
  const status = $("#github-status");
  const g = { owner: form.owner.value, repo: form.repo.value, branch: form.branch.value, token: form.token.value };
  status.classList.remove("ok", "bad");
  if (!g.owner.trim() || !g.repo.trim() || !g.token.trim()) { status.textContent = t("ghMissing"); status.classList.add("bad"); return; }
  status.textContent = t("ghChecking");
  try {
    const info = await new GitHub(g).repoInfo();
    status.textContent = t("ghOk", info.full_name, info.private);
    status.classList.add("ok");
  } catch (e) {
    status.textContent = describeError(e);
    status.classList.add("bad");
  }
});

// ---------- opening files ----------
const input = $("#file-input");
$("#open-pdf").addEventListener("click", () => input.click());
$("#empty-open").addEventListener("click", () => input.click());
$("#empty-sync").addEventListener("click", () => runSync());
input.addEventListener("change", () => { if (input.files.length) importFiles(input.files); input.value = ""; });

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth++;
  $("#drop-hint").hidden = false;
});
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop-hint").hidden = true; } });
window.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  dragDepth = 0;
  $("#drop-hint").hidden = true;
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  importFiles(e.dataTransfer.files);
});
// Desktop app: files opened from the file manager ("Open with Penmit PDF").
window.penmitDesktop?.onOpenFiles?.((files) => {
  importFiles(files.map((f) => new File([f.bytes], f.name, { type: "application/pdf" })));
});

// ---------- keyboard ----------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openMenuEl) { closeMenu(); return; }
  if (!current || dialog.open || renameDialog.open || gotoDialog.open || e.target.closest?.("input, textarea")) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ink.selection) {
    if (e.key === "Escape") { ink.clearSelection(); return; }
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); ink.deleteSelection(); return; }
  }
  if (fullscreen && !mod) {
    const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
    if (step) { e.preventDefault(); viewer.stepRow(e.shiftKey && e.key === " " ? -1 : step); return; }
    if (e.key === "Escape") { exitFullscreen(); return; }
  }
  if (!mod && !e.altKey && k === "f") { if (fullscreen) exitFullscreen(); else enterFullscreen(); return; }
  if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) ink.redo(); else ink.undo(); }
  else if (mod && k === "y") { e.preventDefault(); ink.redo(); }
  else if (mod && (k === "=" || k === "+")) { e.preventDefault(); viewer.setZoom(viewer.zoom * ZOOM_STEP); }
  else if (mod && k === "-") { e.preventDefault(); viewer.setZoom(viewer.zoom / ZOOM_STEP); }
  else if (mod && k === "0") { e.preventDefault(); viewer.setZoom(1); }
  else if (!mod && !e.altKey) {
    const tool = { v: "hand", p: "pen", h: "highlighter", e: "eraser", l: "lasso" }[k];
    if (tool) selectTool(tool);
  }
});

// Safari's own pinch zoom would fight ours.
document.addEventListener("gesturestart", (e) => e.preventDefault());
$("#pages").addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- start ----------
function start() {
  applyI18n();
  // Coming back from Google's sign-in page.
  const back = googleAuth.handleReturn();
  if (back?.popup) {
    // This window was the sign-in pop-up; if the browser kept it open, say so instead of loading the app.
    document.body.innerHTML = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = t("googlePopupDone");
    document.body.append(p);
    return;
  }
  renderToolbar();
  show("library");
  updateSyncLine();
  renderLibrary();
  if (autoSyncOn()) scheduleAutoSync(1_500);
  registerServiceWorker(() => {
    // A new version is ready: reload when it won't interrupt anything.
    updateReady = true;
    reloadIfUpdated();
  });
  if (back?.redirect) {
    if (back.ok) {
      settings.storage = "gdrive";
      saveSettings();
      updateSyncLine();
      if (back.after === "settings") openSettings();
    } else {
      toast(t("googleSignInFailed", "access_denied"), { error: true });
    }
  }
  window.penmit = { version: VERSION, desktop: isDesktop }; // handy when debugging
}
start();
