// PDF rendering and page layout (single, two pages, cover + two pages), zoom and pinch.
import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";

const VENDOR = new URL("../vendor/pdfjs/", import.meta.url).href;
pdfjs.GlobalWorkerOptions.workerSrc = VENDOR + "pdf.worker.min.mjs";

// iOS Safari refuses canvases above ~16.7 megapixels.
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_RENDERED_PAGES = 14;
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 6;
const PAGE_GAP = 12;      // px between pages in a row, if the stylesheet hasn't loaded
const SIDE_PADDING = 20;  // px, likewise

export async function openPdf(bytes) {
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes).slice(), // pdf.js transfers the buffer to its worker
    cMapUrl: VENDOR + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: VENDOR + "standard_fonts/",
    wasmUrl: VENDOR + "wasm/",
    iccUrl: VENDOR + "iccs/",
    isEvalSupported: false,
    enableXfa: false,
  });
  const pdf = await task.promise;
  // Newer pdf.js releases the document through its loading task only.
  if (typeof pdf.destroy !== "function") pdf.destroy = () => task.destroy();
  return pdf;
}

export const isPasswordError = (e) => e?.name === "PasswordException";

export async function renderThumbnail(pdf, width = 420) {
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: ctx, viewport, background: "#ffffff" }).promise;
  page.cleanup();
  return canvas.toDataURL("image/jpeg", 0.85);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Viewer extends EventTarget {
  constructor(scroller, pagesEl) {
    super();
    this.scroller = scroller;
    this.pagesEl = pagesEl;
    this.pdf = null;
    this.pages = [];
    this.layout = "single";
    // "width": rows fill the width and the pages scroll. "page": each row fits the screen
    // whole and the pages move a row at a time (full-screen reading).
    this.fitMode = "width";
    this.zoom = 1;
    this.scale = 1;
    this.visible = new Set();
    this.renderQueue = [];
    this.renderedOrder = [];
    this.renderTimer = 0;
    this.rendering = 0;
    this.gesture = null;

    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = e.target.__page;
        if (!p) continue;
        if (e.isIntersecting) this.visible.add(p); else this.visible.delete(p);
      }
      this.scheduleRender();
      this.#emitPage();
      this.dispatchEvent(new Event("visibility"));
    }, { root: scroller, rootMargin: "120% 60%" });

    let scrollRaf = 0;
    scroller.addEventListener("scroll", () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; this.#emitPage(); });
    }, { passive: true });

    let resizeTimer = 0;
    this.onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!this.pdf) return;
        const page = this.currentPage();
        this.relayout();
        if (this.fitMode === "page") this.scrollToPage(page, false);
      }, 150);
    };
    window.addEventListener("resize", this.onResize);

    // Ctrl/Cmd + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms.
    scroller.addEventListener("wheel", (e) => {
      if (!this.pdf || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
    }, { passive: false });

    this.#attachTouchGestures();
  }

  async load(pdf, { layout = "single", zoom = 1, page = 0 } = {}) {
    this.clear();
    this.pdf = pdf;
    const n = pdf.numPages;
    const proxies = [];
    for (let start = 1; start <= n; start += 24) {
      const batch = [];
      for (let i = start; i < Math.min(start + 24, n + 1); i++) batch.push(pdf.getPage(i));
      proxies.push(...(await Promise.all(batch)));
    }
    this.pages = proxies.map((proxy, index) => {
      const vp = proxy.getViewport({ scale: 1 });
      const el = document.createElement("div");
      el.className = "page";
      el.dataset.index = String(index);
      const pdfCanvas = document.createElement("canvas");
      pdfCanvas.className = "pdf";
      pdfCanvas.width = pdfCanvas.height = 0;
      const inkCanvas = document.createElement("canvas");
      inkCanvas.className = "ink";
      const liveCanvas = document.createElement("canvas");
      liveCanvas.className = "live";
      const num = document.createElement("span");
      num.className = "page-num";
      num.textContent = String(index + 1);
      el.append(pdfCanvas, inkCanvas, liveCanvas, num);
      const p = { index, proxy, w: vp.width, h: vp.height, el, pdfCanvas, inkCanvas, liveCanvas, viewport: vp, renderedScale: 0, task: null };
      el.__page = p;
      return p;
    });
    this.layout = layout;
    this.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    this.build();
    this.scrollToPage(page, false);
  }

  clear() {
    this.io.disconnect();
    for (const p of this.pages) { p.task?.cancel(); p.proxy.cleanup(); }
    this.pages = [];
    this.visible.clear();
    this.renderedOrder = [];
    this.pagesEl.textContent = "";
    if (this.pdf) { this.pdf.destroy(); this.pdf = null; }
  }

  rows() {
    const idx = this.pages.map((p) => p.index);
    const rows = [];
    if (this.layout === "single") {
      for (const i of idx) rows.push([i]);
    } else {
      let i = 0;
      if (this.layout === "cover" && idx.length) { rows.push([0]); i = 1; }
      for (; i < idx.length; i += 2) rows.push(idx.slice(i, i + 2));
    }
    return rows;
  }

  setLayout(layout) {
    if (layout === this.layout) return;
    const page = this.currentPage();
    this.layout = layout;
    this.build();
    this.scrollToPage(page, false);
    this.dispatchEvent(new Event("layoutchange"));
  }

  build() {
    this.io.disconnect();
    this.pagesEl.textContent = "";
    for (const row of this.rows()) {
      const rowEl = document.createElement("div");
      rowEl.className = "page-row";
      for (const i of row) rowEl.append(this.pages[i].el);
      this.pagesEl.append(rowEl);
    }
    this.relayout();
    for (const p of this.pages) this.io.observe(p.el);
  }

  // Fit the typical row to the width. Using the widest row would let one landscape page
  // shrink every portrait page; an unusually wide page scrolls sideways instead.
  fitScale() {
    const cs = getComputedStyle(this.pagesEl);
    const padX = (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) || SIDE_PADDING * 2;
    const padY = (parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)) || 0;
    const rowEl = this.pagesEl.querySelector(".page-row");
    const gap = rowEl ? parseFloat(getComputedStyle(rowEl).columnGap) || 0 : PAGE_GAP;
    const availW = Math.max(120, this.scroller.clientWidth - padX);
    const availH = Math.max(120, this.scroller.clientHeight - padY);
    const fits = this.rows()
      .map((row) => {
        const byWidth = (availW - gap * (row.length - 1)) / row.reduce((s, i) => s + this.pages[i].w, 0);
        if (this.fitMode !== "page") return byWidth;
        return Math.min(byWidth, availH / Math.max(...row.map((i) => this.pages[i].h)));
      })
      .sort((a, b) => a - b);
    const fit = fits[Math.floor((fits.length - 1) / 2)];
    return Number.isFinite(fit) && fit > 0 ? fit : 1;
  }

  relayout() {
    if (!this.pages.length) return;
    this.pagesEl.style.setProperty("--row-h", `${this.scroller.clientHeight}px`);
    this.scale = this.fitScale() * this.zoom;
    for (const p of this.pages) {
      p.el.style.width = `${Math.round(p.w * this.scale)}px`;
      p.el.style.height = `${Math.round(p.h * this.scale)}px`;
      p.viewport = p.proxy.getViewport({ scale: this.scale });
    }
    this.dispatchEvent(new Event("relayout"));
    this.scheduleRender();
  }

  // Keep the point under (clientX, clientY) still while zooming.
  setZoom(zoom, clientX, clientY) {
    zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    if (!this.pages.length || Math.abs(zoom - this.zoom) < 1e-4) return;
    const box = this.scroller.getBoundingClientRect();
    const x = clientX ?? box.left + box.width / 2;
    const y = clientY ?? box.top + box.height / 3;
    const anchor = this.#anchorAt(x, y);
    this.zoom = zoom;
    this.relayout();
    if (anchor) {
      const r = anchor.page.el.getBoundingClientRect();
      this.scroller.scrollLeft += r.left + anchor.fx * r.width - x;
      this.scroller.scrollTop += r.top + anchor.fy * r.height - y;
    }
    this.dispatchEvent(new Event("zoom"));
  }

  #anchorAt(x, y) {
    let best = null;
    let bestDist = Infinity;
    for (const p of this.visible.size ? this.visible : this.pages) {
      const r = p.el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = { page: p, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height }; }
    }
    return best;
  }

  currentPage() {
    if (!this.pages.length) return 0;
    const box = this.scroller.getBoundingClientRect();
    let best = 0;
    let bestArea = -1;
    for (const p of this.visible) {
      const r = p.el.getBoundingClientRect();
      const w = Math.min(r.right, box.right) - Math.max(r.left, box.left);
      const h = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top);
      const area = Math.max(0, w) * Math.max(0, h);
      if (area > bestArea || (area === bestArea && p.index < best)) { bestArea = area; best = p.index; }
    }
    return best;
  }

  setFitMode(mode) {
    if (mode === this.fitMode || !this.pages.length) { this.fitMode = mode; return; }
    const page = this.currentPage();
    this.fitMode = mode;
    this.relayout();
    this.scrollToPage(page, false);
  }

  // The next or previous row (two pages in the two-page layouts).
  stepRow(dir) {
    const rows = this.rows();
    const at = rows.findIndex((r) => r.includes(this.currentPage()));
    const next = rows[clamp(at + dir, 0, rows.length - 1)];
    if (next) this.scrollToPage(next[0]);
  }

  scrollToPage(index, smooth = true) {
    const p = this.pages[clamp(index | 0, 0, this.pages.length - 1)];
    if (!p) return;
    if (this.fitMode === "page" && p.el.parentElement) {
      this.scroller.scrollTo({ top: p.el.parentElement.offsetTop, left: 0, behavior: smooth ? "smooth" : "auto" });
      return;
    }
    const box = this.scroller.getBoundingClientRect();
    const r = p.el.getBoundingClientRect();
    this.scroller.scrollTo({
      top: this.scroller.scrollTop + r.top - box.top - 16,
      left: this.scroller.scrollLeft + r.left - box.left - Math.max(16, (box.width - r.width) / 2),
      behavior: smooth ? "smooth" : "auto",
    });
  }

  #emitPage() {
    const page = this.currentPage();
    if (page !== this.lastPage) {
      this.lastPage = page;
      this.dispatchEvent(new CustomEvent("pagechange", { detail: page }));
    }
  }

  scheduleRender(delay = 60) {
    clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => this.#renderVisible(), delay);
  }

  #outputScale(p) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssPixels = p.w * p.h * this.scale * this.scale;
    return Math.max(0.5, Math.min(dpr, Math.sqrt(MAX_CANVAS_PIXELS / cssPixels)));
  }

  #renderVisible() {
    if (!this.pages.length) return;
    const box = this.scroller.getBoundingClientRect();
    const cy = box.top + box.height / 2;
    const todo = [...this.visible]
      .filter((p) => Math.abs(p.renderedScale - this.scale * this.#outputScale(p)) > 1e-3)
      .sort((a, b) => Math.abs(a.el.getBoundingClientRect().top - cy) - Math.abs(b.el.getBoundingClientRect().top - cy));
    this.renderQueue = todo;
    this.#pump();
  }

  #pump() {
    while (this.rendering < 2 && this.renderQueue.length) {
      const p = this.renderQueue.shift();
      this.rendering++;
      this.#render(p).catch((e) => console.warn("render", p.index, e)).finally(() => {
        this.rendering--;
        this.#pump();
      });
    }
  }

  async #render(p) {
    p.task?.cancel();
    const out = this.#outputScale(p);
    const target = this.scale * out;
    const viewport = p.proxy.getViewport({ scale: target });
    const canvas = document.createElement("canvas");
    canvas.className = "pdf";
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const task = p.proxy.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport,
      annotationMode: pdfjs.AnnotationMode.ENABLE,
      background: "#ffffff",
    });
    p.task = task;
    try {
      await task.promise;
    } catch (e) {
      if (e?.name === "RenderingCancelledException") return;
      throw e;
    } finally {
      if (p.task === task) p.task = null;
    }
    if (Math.abs(target - this.scale * this.#outputScale(p)) > 1e-3) { this.scheduleRender(); }
    p.el.replaceChild(canvas, p.pdfCanvas);
    p.pdfCanvas = canvas;
    p.renderedScale = target;
    this.renderedOrder = this.renderedOrder.filter((q) => q !== p);
    this.renderedOrder.push(p);
    this.#evict();
  }

  #evict() {
    while (this.renderedOrder.length > MAX_RENDERED_PAGES) {
      const idx = this.renderedOrder.findIndex((q) => !this.visible.has(q));
      if (idx < 0) break;
      const [q] = this.renderedOrder.splice(idx, 1);
      q.pdfCanvas.width = q.pdfCanvas.height = 0;
      q.renderedScale = 0;
    }
  }

  // Two fingers pan and pinch-zoom. One finger scrolls natively (or draws, see ink.js).
  #attachTouchGestures() {
    const s = this.scroller;
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    let raf = 0;
    let pending = null;
    s.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2 && this.pdf) {
        this.gesture = { d0: dist(e.touches) || 1, z0: this.zoom, m: mid(e.touches) };
        this.dispatchEvent(new Event("gesturestart"));
        e.preventDefault();
      }
    }, { passive: false });
    s.addEventListener("touchmove", (e) => {
      if (!this.gesture || e.touches.length !== 2) return;
      e.preventDefault();
      pending = { m: mid(e.touches), z: this.gesture.z0 * dist(e.touches) / this.gesture.d0 };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!pending || !this.gesture) return;
        const { m, z } = pending;
        s.scrollLeft -= m.x - this.gesture.m.x;
        s.scrollTop -= m.y - this.gesture.m.y;
        this.gesture.m = m;
        this.setZoom(z, m.x, m.y);
      });
    }, { passive: false });
    const end = (e) => {
      if (this.gesture && e.touches.length < 2) {
        this.gesture = null;
        this.dispatchEvent(new Event("gestureend"));
        this.scheduleRender(0);
      }
    };
    s.addEventListener("touchend", end);
    s.addEventListener("touchcancel", end);
  }

  destroy() {
    this.clear();
    window.removeEventListener("resize", this.onResize);
  }
}
