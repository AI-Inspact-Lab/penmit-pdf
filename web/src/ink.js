// Handwriting: pen, highlighter and stroke eraser, with pressure, palm rejection, undo/redo.
//
// A document's ink is { id, strokes: { [strokeId]: Stroke }, deleted: { [strokeId]: time } }.
// Stroke = { id, page, tool: "pen" | "highlighter", color, width, opacity?, pts: [x, y, pressure, ...], t }
// Points are in PDF user space (points, origin bottom-left), so they stay put at any zoom
// and map one-to-one onto PDF ink annotations. Deleted ids are kept as tombstones so
// devices that sync later learn about the deletion instead of bringing the stroke back.

export const PEN_COLORS = ["#1b1f27", "#2453c9", "#d23b30", "#1f8a4c"];
export const HIGHLIGHT_COLORS = ["#ffd400", "#7be37b", "#ff8fc8", "#7fd4ff"];
export const WIDTHS = { pen: [0.8, 1.6, 3.2], highlighter: [8, 14, 22] }; // PDF points
export const HIGHLIGHT_OPACITY = 0.35;
const ERASER_RADIUS_PX = 12;
const MAX_INK_PIXELS = 10_000_000;

export function emptyInk(id) {
  return { id, strokes: {}, deleted: {} };
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Width factor from pen pressure; 0.5 (mouse, or a pen without pressure) gives the nominal width.
export const pressureFactor = (p) => 0.45 + 1.1 * Math.min(1, Math.max(0, p));

export function strokesByPage(model) {
  const map = new Map();
  for (const s of Object.values(model.strokes)) {
    if (!map.has(s.page)) map.set(s.page, []);
    map.get(s.page).push(s);
  }
  for (const list of map.values()) list.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  return map;
}

export function drawStroke(ctx, s) {
  const pts = s.pts;
  const n = pts.length / 3;
  if (!n) return;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.tool === "highlighter") {
    ctx.globalAlpha = s.opacity ?? HIGHLIGHT_OPACITY;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    if (n === 1) ctx.lineTo(pts[0] + 0.01, pts[1]);
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(pts[i * 3], pts[i * 3 + 1], (pts[i * 3] + pts[i * 3 + 3]) / 2, (pts[i * 3 + 1] + pts[i * 3 + 4]) / 2);
    }
    if (n > 1) ctx.lineTo(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1]);
    ctx.stroke();
  } else if (n === 1) {
    ctx.beginPath();
    ctx.arc(pts[0], pts[1], (s.width * pressureFactor(pts[2])) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    let px = pts[0];
    let py = pts[1];
    for (let i = 1; i < n; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const last = i === n - 1;
      const mx = last ? x : (x + pts[i * 3 + 3]) / 2;
      const my = last ? y : (y + pts[i * 3 + 4]) / 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(x, y, mx, my);
      ctx.lineWidth = s.width * pressureFactor((pts[i * 3 - 1] + pts[i * 3 + 2]) / 2);
      ctx.stroke();
      px = mx;
      py = my;
    }
  }
  ctx.restore();
}

const bboxCache = new WeakMap();
function bbox(s) {
  let b = bboxCache.get(s);
  if (!b) {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < s.pts.length; i += 3) {
      b.x0 = Math.min(b.x0, s.pts[i]); b.x1 = Math.max(b.x1, s.pts[i]);
      b.y0 = Math.min(b.y0, s.pts[i + 1]); b.y1 = Math.max(b.y1, s.pts[i + 1]);
    }
    bboxCache.set(s, b);
  }
  return b;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

function hits(s, x, y, r) {
  const b = bbox(s);
  const pad = r + s.width;
  if (x < b.x0 - pad || x > b.x1 + pad || y < b.y0 - pad || y > b.y1 + pad) return false;
  const lim = r + s.width / 2;
  const lim2 = lim * lim;
  const p = s.pts;
  if (p.length === 3) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= lim2;
  for (let i = 3; i < p.length; i += 3) {
    if (segDist2(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= lim2) return true;
  }
  return false;
}

const round2 = (v) => Math.round(v * 100) / 100;

export class Ink extends EventTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.scroller = viewer.scroller;
    this.model = null;
    this.byPage = new Map();
    this.tool = "pen";
    this.style = {
      pen: { color: PEN_COLORS[0], width: WIDTHS.pen[1] },
      highlighter: { color: HIGHLIGHT_COLORS[0], width: WIDTHS.highlighter[1] },
    };
    this.fingerDraw = false;
    this.active = null;
    this.drag = null;
    this.lastPenAt = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.liveRaf = 0;

    viewer.addEventListener("relayout", () => this.#refreshVisible(true));
    viewer.addEventListener("visibility", () => this.#refreshVisible(false));
    viewer.addEventListener("gesturestart", () => this.#cancelActive());

    const pages = viewer.pagesEl;
    pages.addEventListener("pointerdown", (e) => this.#down(e));
    pages.addEventListener("pointermove", (e) => this.#move(e));
    pages.addEventListener("pointerup", (e) => this.#up(e, false));
    pages.addEventListener("pointercancel", (e) => this.#up(e, true));
    pages.addEventListener("lostpointercapture", (e) => { if (this.active?.pointerId === e.pointerId) this.#up(e, false); });

    // Keep the page from scrolling under the pen (and under a finger while it draws).
    // pointerdown fires before touchstart, so `active` is already set for a stroke.
    this.scroller.addEventListener("touchstart", (e) => {
      const stylus = [...e.changedTouches].some((t) => t.touchType === "stylus");
      if (this.active || (stylus && this.tool !== "hand")) e.preventDefault();
    }, { passive: false });
    this.scroller.addEventListener("touchmove", (e) => {
      if (this.active) e.preventDefault();
    }, { passive: false });
  }

  setModel(model) {
    this.model = model;
    this.byPage = strokesByPage(model);
    this.undoStack = [];
    this.redoStack = [];
    this.#emit("history");
    this.redrawAll();
  }

  setTool(tool) {
    this.tool = tool;
    this.scroller.dataset.tool = tool;
  }

  setFingerDraw(on) {
    this.fingerDraw = on;
    this.viewer.pagesEl.classList.toggle("finger-draw", on);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  // ---------- drawing on screen ----------

  #inkScale(p) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = p.w * p.h * this.viewer.scale * this.viewer.scale;
    return Math.max(0.5, Math.min(dpr, Math.sqrt(MAX_INK_PIXELS / css)));
  }

  #prepare(canvas, p) {
    const k = this.#inkScale(p);
    const w = Math.max(1, Math.round(p.w * this.viewer.scale * k));
    const h = Math.max(1, Math.round(p.h * this.viewer.scale * k));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const T = p.viewport.transform;
    ctx.setTransform(T[0] * k, T[1] * k, T[2] * k, T[3] * k, T[4] * k, T[5] * k);
    return ctx;
  }

  drawPage(p) {
    if (!this.model) return;
    const ctx = this.#prepare(p.inkCanvas, p);
    for (const s of this.byPage.get(p.index) || []) drawStroke(ctx, s);
    p.inkScale = this.viewer.scale;
  }

  redrawAll() {
    for (const p of this.viewer.pages) {
      if (this.viewer.visible.has(p)) this.drawPage(p);
      else { p.inkCanvas.width = p.inkCanvas.height = 0; p.inkScale = 0; }
    }
  }

  #refreshVisible(force) {
    if (!this.model) return;
    for (const p of this.viewer.pages) {
      const vis = this.viewer.visible.has(p);
      if (vis && (force || p.inkScale !== this.viewer.scale)) this.drawPage(p);
      else if (!vis && p.inkScale) { p.inkCanvas.width = p.inkCanvas.height = 0; p.inkScale = 0; }
    }
  }

  #drawLive() {
    this.liveRaf = 0;
    const a = this.active;
    if (!a || a.tool === "eraser") return;
    const ctx = this.#prepare(a.page.liveCanvas, a.page);
    drawStroke(ctx, { tool: a.tool, color: a.color, width: a.width, opacity: HIGHLIGHT_OPACITY, pts: a.pts });
  }

  #clearLive(p) {
    p.liveCanvas.width = p.liveCanvas.height = 0;
  }

  // ---------- input ----------

  #down(e) {
    const el = e.target.closest?.(".page");
    const p = el?.__page;
    if (!p || !this.model) return;
    if (e.pointerType === "pen") {
      this.lastPenAt = performance.now();
      this.#emit("pen");
    }
    if (this.viewer.gesture) return;

    if (this.tool === "hand") {
      if (e.pointerType === "mouse" && e.button === 0) {
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        this.scroller.classList.add("dragging");
        el.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      }
      return;
    }

    const canDraw =
      e.pointerType === "pen" ||
      (e.pointerType === "mouse" && e.button === 0) ||
      (e.pointerType === "touch" && this.fingerDraw && e.isPrimary && performance.now() - this.lastPenAt > 1500);
    if (!canDraw || this.active) return;

    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const style = this.style[this.tool] || {};
    this.active = {
      pointerId: e.pointerId,
      page: p,
      tool: this.tool,
      color: style.color,
      width: style.width,
      rect: el.getBoundingClientRect(),
      pts: [],
      erased: [],
    };
    this.#addPoints(e);
  }

  #move(e) {
    if (this.drag && e.pointerId === this.drag.id) {
      this.scroller.scrollLeft -= e.clientX - this.drag.x;
      this.scroller.scrollTop -= e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      return;
    }
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId) return;
    e.preventDefault();
    this.#addPoints(e);
  }

  #addPoints(e) {
    const a = this.active;
    const events = e.getCoalescedEvents?.() || [];
    const list = events.length ? events : [e];
    const minStep = 0.35 / this.viewer.scale; // ~0.35 px on screen
    for (const ev of list) {
      const [x, y] = a.page.viewport.convertToPdfPoint(ev.clientX - a.rect.left, ev.clientY - a.rect.top);
      const pressure = ev.pointerType === "pen" ? (ev.pressure > 0 ? ev.pressure : 0.5) : 0.5;
      const n = a.pts.length;
      if (n && Math.hypot(x - a.pts[n - 3], y - a.pts[n - 2]) < minStep) continue;
      a.pts.push(round2(x), round2(y), round2(pressure));
      if (a.tool === "eraser") this.#eraseAt(a.page, x, y);
    }
    if (a.tool !== "eraser" && !this.liveRaf) this.liveRaf = requestAnimationFrame(() => this.#drawLive());
  }

  #up(e, cancelled) {
    if (this.drag && e.pointerId === this.drag.id) {
      this.drag = null;
      this.scroller.classList.remove("dragging");
      return;
    }
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId) return;
    this.active = null;
    if (this.liveRaf) { cancelAnimationFrame(this.liveRaf); this.liveRaf = 0; }
    this.#clearLive(a.page);
    if (a.tool === "eraser") {
      if (a.erased.length) this.#push({ type: "erase", strokes: a.erased });
      return;
    }
    if (cancelled || !a.pts.length) return;
    const stroke = {
      id: newId(),
      page: a.page.index,
      tool: a.tool,
      color: a.color,
      width: a.width,
      pts: a.pts,
      t: Date.now(),
    };
    if (a.tool === "highlighter") stroke.opacity = HIGHLIGHT_OPACITY;
    this.#add(stroke);
    this.#push({ type: "add", strokes: [stroke] });
    this.#changed();
  }

  #cancelActive() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.#clearLive(a.page);
    if (a.tool === "eraser" && a.erased.length) this.#push({ type: "erase", strokes: a.erased });
  }

  #eraseAt(p, x, y) {
    const r = ERASER_RADIUS_PX / this.viewer.scale;
    const list = this.byPage.get(p.index);
    if (!list?.length) return;
    const gone = list.filter((s) => hits(s, x, y, r));
    if (!gone.length) return;
    for (const s of gone) this.#remove(s);
    this.active.erased.push(...gone);
    this.drawPage(p);
    this.#changed();
  }

  // ---------- model changes ----------

  #add(s, redraw = false) {
    this.model.strokes[s.id] = s;
    delete this.model.deleted[s.id];
    if (!this.byPage.has(s.page)) this.byPage.set(s.page, []);
    this.byPage.get(s.page).push(s);
    const p = this.viewer.pages[s.page];
    if (p && this.viewer.visible.has(p)) {
      if (redraw) this.drawPage(p);
      else if (p.inkScale === this.viewer.scale) {
        const k = this.#inkScale(p);
        const ctx = p.inkCanvas.getContext("2d");
        const T = p.viewport.transform;
        ctx.setTransform(T[0] * k, T[1] * k, T[2] * k, T[3] * k, T[4] * k, T[5] * k);
        drawStroke(ctx, s);
      } else this.drawPage(p);
    }
  }

  #remove(s) {
    delete this.model.strokes[s.id];
    this.model.deleted[s.id] = Date.now();
    const list = this.byPage.get(s.page);
    if (list) this.byPage.set(s.page, list.filter((q) => q.id !== s.id));
  }

  // Restored strokes get new ids: the old ids are tombstoned and may already be synced.
  #restore(strokes) {
    const copies = strokes.map((s) => ({ ...s, id: newId(), t: s.t }));
    for (const c of copies) this.#add(c, true);
    return copies;
  }

  #removeAll(strokes) {
    const pages = new Set();
    for (const s of strokes) { if (this.model.strokes[s.id]) { this.#remove(s); pages.add(s.page); } }
    for (const i of pages) { const p = this.viewer.pages[i]; if (p && this.viewer.visible.has(p)) this.drawPage(p); }
  }

  #push(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.#emit("history");
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    if (a.type === "add") this.#removeAll(a.strokes);
    else a.strokes = this.#restore(a.strokes);
    this.redoStack.push(a);
    this.#emit("history");
    this.#changed();
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    if (a.type === "add") a.strokes = this.#restore(a.strokes);
    else this.#removeAll(a.strokes);
    this.undoStack.push(a);
    this.#emit("history");
    this.#changed();
  }

  // Replace the model (after a sync merged in strokes from another device).
  replaceModel(model) {
    this.model = model;
    this.byPage = strokesByPage(model);
    this.undoStack = [];
    this.redoStack = [];
    this.#emit("history");
    this.redrawAll();
  }

  #changed() { this.#emit("change"); }
  #emit(type) { this.dispatchEvent(new Event(type)); }
}
