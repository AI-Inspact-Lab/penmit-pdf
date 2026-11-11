import { t, applyI18n, lang } from "./i18n.js";
import { db, requestPersistence, sha256Hex } from "./db.js";
import { Viewer, openPdf, renderThumbnail, isPasswordError, MIN_ZOOM, MAX_ZOOM } from "./viewer.js";
import { Ink, emptyInk, strokesByPage, PEN_COLORS, HIGHLIGHT_COLORS, WIDTHS } from "./ink.js";
import { exportAnnotated, EncryptedPdfError } from "./export.js";
import { GitHub, GitHubBackend } from "./github.js";
import { DriveBackend } from "./gdrive.js";
import { googleAuth, NeedsGoogleSignIn } from "./googleauth.js";
import { sync, mergeInk, sameInk } from "./sync.js";
import { saveFile, registerServiceWorker, isDesktop, isAndroidApp } from "./platform.js";

export const VERSION = "0.3.0";
const $ = (sel) => document.querySelector(sel);

// ---------- settings ----------
const SETTINGS_KEY = "penmit.settings";
function readSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch { return {}; }
}
const settings = {
  fingerDraw: false,
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
ink.setFingerDraw(settings.fingerDraw);
if (settings.style) {
  for (const k of ["pen", "highlighter"]) if (settings.style[k]) ink.style[k] = { ...ink.style[k], ...settings.style[k] };
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
  el.dataset.state = last ? "ok" : "never";
  el.textContent = `${where} · ${last ? agoLabel(last) : t("lineNever")}`;
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
  if (added) { toast(t("added", added)); requestPersistence(); }
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
  await viewer.load(pdf, { layout: view.layout || settings.layout, zoom: view.zoom || 1, page: view.page || 0 });
  ink.setModel((await db.get("ink", id)) || emptyInk(id));
  syncLayoutButtons();
  syncZoomLabel();
  syncPageIndicator(viewer.currentPage());
  flashPageIndicator();
  syncHistoryButtons();
  await db.put("docs", { ...d, openedAt: Date.now(), pageCount: d.pageCount || pdf.numPages });
}

async function closeDoc() {
  if (!current) return;
  await flushInk();
  const d = (await db.get("docs", current.id)) || current.doc;
  await db.put("docs", { ...d, view: { layout: viewer.layout, zoom: viewer.zoom, page: viewer.currentPage() } });
  viewer.clear();
  ink.model = null;
  current = null;
  document.title = "Penmit PDF";
  show("library");
  await renderLibrary();
  if (storageReady() && inkDirty) runSync({ quiet: true });
}

// Save handwriting shortly after each change, and right away when the app is hidden.
let saveTimer = 0;
let inkDirty = false;
ink.addEventListener("change", () => {
  inkDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushInk, 400);
});
ink.addEventListener("history", syncHistoryButtons);
async function flushInk() {
  clearTimeout(saveTimer);
  if (current && ink.model) await db.put("ink", ink.model);
}
document.addEventListener("visibilitychange", () => { if (document.hidden) flushInk(); });
window.addEventListener("pagehide", () => { flushInk(); });

function syncHistoryButtons() {
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
  for (const b of document.querySelectorAll("[data-tool]")) b.setAttribute("aria-checked", String(b.dataset.tool === tool));
  const bar = $("#toolbar");
  bar.classList.toggle("eraser-mode", tool === "eraser");
  bar.classList.toggle("hand-mode", tool === "hand");
  const kind = tool === "highlighter" ? "highlighter" : "pen";
  const style = ink.style[kind];
  $("[data-tool=pen] .tool-color").style.setProperty("--c", ink.style.pen.color);
  $("[data-tool=highlighter] .tool-color").style.setProperty("--c", ink.style.highlighter.color);

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
  settings.style = { pen: ink.style.pen, highlighter: ink.style.highlighter };
  saveSettings();
}
function selectTool(tool) {
  ink.setTool(tool);
  settings.tool = tool;
  saveSettings();
  renderToolbar();
}
for (const b of document.querySelectorAll("[data-tool]")) b.addEventListener("click", () => selectTool(b.dataset.tool));

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
    const bytes = await exportAnnotated(pdfBytes, strokesByPage(model));
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
    if (!quiet) { toast(t("googleNeedsSignIn")); openSettings(); }
    return;
  }
  const backend = settings.storage === "gdrive" ? new DriveBackend() : new GitHubBackend(settings.github);
  syncing = true;
  setSyncBusy(true);
  if (!quiet) toast(t("syncing"), { ms: 600_000 });
  try {
    await flushInk();
    const stats = await sync(backend, store);
    inkDirty = false;
    settings.lastSync = { ...settings.lastSync, [settings.storage]: Date.now() };
    saveSettings();
    updateSyncLine();
    if (!quiet || stats.down || stats.merged) toast(t("syncDone", stats));
    if (!current) await renderLibrary();
  } catch (e) {
    console.error(e);
    toast(t("syncFailed", describeError(e)), { error: true, ms: 6000 });
  } finally {
    syncing = false;
    setSyncBusy(false);
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
  form.fingerDraw.checked = settings.fingerDraw;
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
  settings.fingerDraw = form.fingerDraw.checked;
  ink.setFingerDraw(settings.fingerDraw);
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
  if (!current || dialog.open || renameDialog.open || e.target.closest?.("input, textarea")) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) ink.redo(); else ink.undo(); }
  else if (mod && k === "y") { e.preventDefault(); ink.redo(); }
  else if (mod && (k === "=" || k === "+")) { e.preventDefault(); viewer.setZoom(viewer.zoom * ZOOM_STEP); }
  else if (mod && k === "-") { e.preventDefault(); viewer.setZoom(viewer.zoom / ZOOM_STEP); }
  else if (mod && k === "0") { e.preventDefault(); viewer.setZoom(1); }
  else if (!mod && !e.altKey) {
    const tool = { v: "hand", p: "pen", h: "highlighter", e: "eraser" }[k];
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
  registerServiceWorker();
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
