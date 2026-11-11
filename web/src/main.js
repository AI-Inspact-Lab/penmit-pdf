import { t, applyI18n } from "./i18n.js";
import { db, requestPersistence, sha256Hex } from "./db.js";
import { Viewer, openPdf, renderThumbnail, isPasswordError, MIN_ZOOM, MAX_ZOOM } from "./viewer.js";
import { Ink, emptyInk, strokesByPage, PEN_COLORS, HIGHLIGHT_COLORS, WIDTHS } from "./ink.js";
import { exportAnnotated, EncryptedPdfError } from "./export.js";
import { GitHub, sync, mergeInk, sameInk } from "./github.js";
import { saveFile, registerServiceWorker } from "./platform.js";

export const VERSION = "0.1.0";
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
  github: { owner: "", repo: "", branch: "", token: "" },
  ...readSettings(),
};
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
}
const githubReady = () => Boolean(settings.github.owner && settings.github.repo && settings.github.token);

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
  $("#library").hidden = view !== "library";
  $("#reader").hidden = view !== "reader";
}

// ---------- library ----------
const PLACEHOLDER = '<svg class="ph i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.8h8l4 4v14.4H6z"/><path d="M14 2.8v4h4"/></svg>';

async function renderLibrary() {
  const docs = (await db.getAll("docs"))
    .filter((d) => !d.deleted)
    .sort((a, b) => (b.openedAt || b.addedAt || 0) - (a.openedAt || a.addedAt || 0));
  const list = $("#doc-list");
  list.textContent = "";
  $("#lib-empty").hidden = docs.length > 0;
  for (const d of docs) {
    const li = document.createElement("li");
    li.className = "doc";
    li.dataset.id = d.id;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "doc-open";
    const thumb = document.createElement("div");
    thumb.className = "doc-thumb";
    if (d.thumb) {
      const img = new Image();
      img.alt = "";
      img.src = d.thumb;
      thumb.append(img);
    } else {
      thumb.innerHTML = PLACEHOLDER;
    }
    const name = document.createElement("p");
    name.className = "doc-name";
    name.textContent = d.name;
    const meta = document.createElement("p");
    meta.className = "doc-meta";
    meta.textContent = d.pageCount ? t("pages", d.pageCount) : "";
    if (d.synced) {
      const s = document.createElement("span");
      s.className = "synced";
      s.textContent = `· ${t("synced")}`;
      meta.append(" ", s);
    }
    open.append(thumb, name, meta);
    open.addEventListener("click", () => openDoc(d.id));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "doc-del";
    del.setAttribute("aria-label", `${t("deleteDoc")}: ${d.name}`);
    del.title = t("deleteDoc");
    del.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>';
    del.addEventListener("click", () => deleteDoc(d));
    li.append(open, del);
    list.append(li);
  }
  for (const d of docs) if (!d.thumb) ensureThumb(d);
}

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
  if (githubReady() && inkDirty) runSync({ quiet: true });
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
  for (const b of document.querySelectorAll("[data-layout]")) b.setAttribute("aria-pressed", String(b.dataset.layout === viewer.layout));
}
function syncZoomLabel() { $("#zoom-fit").textContent = `${Math.round(viewer.zoom * 100)}%`; }
function syncPageIndicator(i) { $("#page-ind").textContent = viewer.pages.length ? `${i + 1} / ${viewer.pages.length}` : ""; }

viewer.addEventListener("pagechange", (e) => syncPageIndicator(e.detail));
viewer.addEventListener("zoom", syncZoomLabel);

for (const b of document.querySelectorAll("[data-layout]")) {
  b.addEventListener("click", () => {
    viewer.setLayout(b.dataset.layout);
    settings.layout = b.dataset.layout;
    saveSettings();
    syncLayoutButtons();
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
  bar.style.setProperty("--hl", ink.style.highlighter.color);

  const swatches = $("#swatches");
  swatches.textContent = "";
  for (const color of kind === "highlighter" ? HIGHLIGHT_COLORS : PEN_COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(color === style.color));
    b.setAttribute("aria-label", color);
    const dot = document.createElement("span");
    dot.style.background = color;
    b.append(dot);
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
  toast(t("exporting"), { ms: 60_000 });
  try {
    const bytes = await exportAnnotated(current.bytes, strokesByPage(ink.model));
    const base = current.doc.name.replace(/\.pdf$/i, "");
    const saved = await saveFile(`${base} (Penmit).pdf`, bytes);
    if (saved !== false) toast(t("exported")); else $("#toast").hidden = true;
  } catch (e) {
    console.error(e);
    toast(e instanceof EncryptedPdfError ? t("encryptedExport") : t("exportFailed", e.message), { error: true });
  }
}

// ---------- GitHub sync ----------
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
function describeError(e) {
  if (e.tooLarge) return t("errTooLarge", e.tooLarge);
  switch (e.status) {
    case 0: return t("errNetwork");
    case 401: return t("errAuth");
    case 403: return t("errForbidden");
    case 404: return t("errNotFound");
    case 429: return t("errRate");
    default: return e.message || String(e);
  }
}
function setSyncBusy(busy) {
  for (const b of [$("#lib-sync"), $("#reader-sync")]) { b.classList.toggle("spin", busy); b.disabled = busy; }
}
async function runSync({ quiet = false } = {}) {
  if (syncing) return;
  if (!githubReady()) {
    if (!quiet) { toast(t("syncNotSet")); openSettings(); }
    return;
  }
  syncing = true;
  setSyncBusy(true);
  if (!quiet) toast(t("syncing"), { ms: 600_000 });
  try {
    await flushInk();
    const stats = await sync(new GitHub(settings.github), store);
    inkDirty = false;
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
function openSettings() {
  const g = settings.github;
  form.owner.value = g.owner;
  form.repo.value = g.repo;
  form.branch.value = g.branch;
  form.token.value = g.token;
  form.fingerDraw.checked = settings.fingerDraw;
  $("#github-status").textContent = "";
  $("#version").textContent = t("version", VERSION);
  dialog.showModal();
}
$("#lib-settings").addEventListener("click", openSettings);
dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "save") return;
  settings.github = {
    owner: form.owner.value.trim(),
    repo: form.repo.value.trim(),
    branch: form.branch.value.trim(),
    token: form.token.value.trim(),
  };
  settings.fingerDraw = form.fingerDraw.checked;
  ink.setFingerDraw(settings.fingerDraw);
  saveSettings();
  toast(t("saved"));
});
$("#test-github").addEventListener("click", async () => {
  const status = $("#github-status");
  const g = { owner: form.owner.value, repo: form.repo.value, branch: form.branch.value, token: form.token.value };
  status.className = "status";
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
  if (!current || dialog.open || e.target.closest?.("input, textarea")) return;
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
applyI18n();
renderToolbar();
show("library");
renderLibrary();
registerServiceWorker();
window.penmit = { version: VERSION }; // handy when debugging
