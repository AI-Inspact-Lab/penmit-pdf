"""Partial eraser, lasso selection (move, resize, recolour, duplicate, delete), blank pages,
the pages panel (thumbnails and table of contents) and exporting blank pages.
Run `node tests/make_test_pdf.mjs` first."""
import http.server, socketserver, threading, json, subprocess, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WEB = str(ROOT / "web")
S = str(ROOT / "tests" / "out") + "/"
PORT = 8795


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

INK = """async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('penmit'); r.onsuccess = () => res(r.result); });
  const all = await new Promise((res) => { const q = db.transaction('ink').objectStore('ink').getAll(); q.onsuccess = () => res(q.result); });
  db.close();
  const m = all[0] || { strokes: {}, pages: {}, deleted: {} };
  return { strokes: Object.values(m.strokes).map(s => {
      const xs = s.pts.filter((_, i) => i % 3 === 0), ys = s.pts.filter((_, i) => i % 3 === 1);
      return { id: s.id, page: s.page, tool: s.tool, color: s.color, w: s.width, n: xs.length,
               x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    }), pages: m.pages || {}, deleted: Object.keys(m.deleted).length };
}"""

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1180, "height": 860}, locale="ko-KR", accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(f"http://localhost:{PORT}/")
    page.wait_for_selector("#library:not([hidden])")
    cdp = ctx.new_cdp_session(page)

    def settle(ms=700):
        page.wait_for_timeout(ms)

    def ink():
        settle(600)
        return page.evaluate(INK)

    def drag(points, ptype="pen"):
        x0, y0 = points[0]
        cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "clickCount": 1, "pointerType": ptype, "force": 0.5})
        for x, y in points[1:]:
            cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1, "pointerType": ptype, "force": 0.5})
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": points[-1][0], "y": points[-1][1], "button": "left", "buttons": 0, "clickCount": 1, "pointerType": ptype})
        page.wait_for_timeout(120)

    def line(x0, y0, x1, y1, n=30):
        return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]

    def tool(name):
        page.locator(f".tool[data-tool={name}]").click()

    page.set_input_files("#file-input", S + "test.pdf")
    page.wait_for_selector("#reader:not([hidden])")
    settle(1200)
    p1 = page.locator(".page").first.bounding_box()
    X = lambda f: p1["x"] + p1["width"] * f
    Y = lambda f: p1["y"] + p1["height"] * f

    # ---------- partial eraser ----------
    tool("pen")
    drag(line(X(0.15), Y(0.2), X(0.85), Y(0.2)))
    check(len(ink()["strokes"]) == 1, "a long stroke")
    tool("eraser")
    check(page.locator("#eraser-opts").is_visible() and page.locator("#swatches").is_hidden(), "eraser shows its own options")
    page.locator("[data-erase=partial]").click()
    drag(line(X(0.5), Y(0.15), X(0.5), Y(0.25), 10))
    st = ink()["strokes"]
    left = [s for s in st if s["x1"] < X(0.5)]
    check(len(st) == 2 and all(s["n"] >= 2 for s in st), f"the partial eraser cut the stroke in two ({len(st)} pieces)")
    xs = sorted((round(s["x0"]), round(s["x1"])) for s in st)
    check(xs[0][1] < xs[1][0], f"there is a gap where the eraser went {xs}")
    page.locator("#undo").click()
    check(len(ink()["strokes"]) == 1, "undo brings the whole stroke back")
    page.locator("#redo").click()
    check(len(ink()["strokes"]) == 2, "redo cuts it again")
    page.locator("[data-erase=stroke]").click()
    drag(line(X(0.3), Y(0.15), X(0.3), Y(0.25), 10))
    check(len(ink()["strokes"]) == 1, "the whole-stroke eraser removes a piece at once")
    page.locator("#undo").click()
    page.locator("#undo").click()
    page.locator("#undo").click()
    check(len(ink()["strokes"]) == 0, "undo all the way back to an empty page")

    # ---------- lasso ----------
    tool("pen")
    drag(line(X(0.2), Y(0.35), X(0.4), Y(0.35)))
    drag(line(X(0.6), Y(0.35), X(0.8), Y(0.35)))
    before = sorted(ink()["strokes"], key=lambda s: s["x0"])
    tool("lasso")
    check(page.locator("#lasso-hint").is_visible(), "lasso shows a hint")
    loop = [(X(0.15), Y(0.30)), (X(0.45), Y(0.30)), (X(0.45), Y(0.40)), (X(0.15), Y(0.40)), (X(0.15), Y(0.30))]
    pts = []
    for (ax, ay), (bx, by) in zip(loop, loop[1:]):
        pts += line(ax, ay, bx, by, 10)
    drag(pts)
    check(page.locator(".selection").count() == 1 and page.locator(".sel-bar button").count() == 6, "the lasso selected something and shows its buttons")
    # Move it by dragging inside the box.
    box = page.locator(".selection").bounding_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    drag(line(cx, cy, cx + 100, cy + 60, 12), "mouse")
    after = sorted(ink()["strokes"], key=lambda s: s["x0"])
    moved = [s for s in after if s["id"] not in {q["id"] for q in before}]
    check(len(after) == 2 and len(moved) == 1, "moving replaces only the selected stroke")
    scale = p1["width"] / 612
    dx = (moved[0]["x0"] - before[0]["x0"]) * scale
    dy = (moved[0]["y0"] - before[0]["y0"]) * scale
    check(abs(dx - 100) < 4 and abs(dy + 60) < 4, f"moved by the drag (dx {dx:.1f}, dy {dy:.1f} on screen)")
    # Resize from a corner.
    box = page.locator(".selection").bounding_box()
    se = page.locator(".sel-handle.se").bounding_box()
    hx, hy = se["x"] + se["width"] / 2, se["y"] + se["height"] / 2
    drag(line(hx, hy, hx + box["width"], hy + box["height"], 12), "mouse")
    sel_stroke = [s for s in ink()["strokes"] if s["id"] not in {before[1]["id"]}][0]
    check(1.8 < (sel_stroke["x1"] - sel_stroke["x0"]) / (before[0]["x1"] - before[0]["x0"]) < 2.2 and sel_stroke["w"] > before[0]["w"] * 1.8,
          f"resized about twice as big, line width too ({sel_stroke['w']})")
    # Recolour, duplicate, delete.
    page.locator(".sel-bar .sel-color").nth(2).click()
    st = ink()["strokes"]
    check(sum(1 for s in st if s["color"] == "#d23b30") == 1 and len(st) == 2, "recoloured the selection red")
    page.locator(".sel-bar .sel-duplicate").click()
    check(len(ink()["strokes"]) == 3, "duplicated it")
    page.locator(".sel-bar .sel-delete").click()
    check(len(ink()["strokes"]) == 2 and page.locator(".selection").count() == 0, "deleted the copy and cleared the selection")
    page.locator("#undo").click()
    check(len(ink()["strokes"]) == 3, "undo brings the deleted copy back")
    tool("pen")
    check(page.locator(".selection").count() == 0, "switching tools clears the selection")

    # ---------- pages panel ----------
    page.locator("#pages-btn").click()
    settle(1200)
    check(page.locator("#pages-panel").is_visible() and page.locator("#thumbs .thumb").count() == 6, "the pages panel lists six pages")
    drawn = page.evaluate("[...document.querySelectorAll('#thumbs canvas')].filter(c => c.width > 100).length")
    check(drawn >= 4, f"thumbnails are drawn ({drawn})")
    p_after = page.locator(".page").first.bounding_box()
    check(p_after["x"] > 252, "on a wide screen the panel sits beside the pages")
    page.locator("#thumbs .thumb").nth(3).locator(".thumb-btn").click()
    settle()
    check(page.locator("#page-ind").inner_text().strip() == "4 / 6", f"tapping a thumbnail goes there ({page.locator('#page-ind').inner_text()})")
    check("current" in page.locator("#thumbs .thumb").nth(3).get_attribute("class"), "the current page is marked")

    page.locator("[data-pp=outline]").click()
    settle()
    titles = page.locator("#outline button").all_inner_texts()
    check(titles == ["Part A", "Part B", "Part B.1"], f"the table of contents is listed {titles}")
    page.locator("#outline button", has_text="Part B.1").click()
    settle()
    check(page.locator("#page-ind").inner_text().strip() == "6 / 6", f"a contents entry goes to its page ({page.locator('#page-ind').inner_text()})")
    page.locator("#outline button", has_text="Part A").click()
    settle()
    check(page.locator("#page-ind").inner_text().strip() == "3 / 6", "Part A is page 3")

    # ---------- blank pages ----------
    page.locator("[data-pp=thumbs]").click()
    settle()
    page.locator("#thumbs .thumb").nth(0).locator(".thumb-more").click()
    page.locator(".menu [data-action=add-blank]").click()
    settle(900)
    check(page.locator(".page").count() == 7 and page.locator(".page").nth(1).get_attribute("class").find("blank-page") >= 0, "a blank page was added after page 1")
    check(page.locator("#page-ind").inner_text().strip() == "2 / 7", f"and it is shown ({page.locator('#page-ind').inner_text()})")
    check(page.locator("#thumbs .thumb").count() == 7, "the panel shows it")
    bp = page.locator(".page").nth(1).bounding_box()
    tool("pen")
    drag(line(bp["x"] + 60, bp["y"] + 120, bp["x"] + 260, bp["y"] + 160))
    data = ink()
    blank_ids = list(data["pages"].keys())
    on_blank = [s for s in data["strokes"] if s["page"] == f"b:{blank_ids[0]}"] if blank_ids else []
    check(len(blank_ids) == 1 and len(on_blank) == 1, "writing on the blank page is kept with it")
    page.locator("#add-blank").click()
    settle(900)
    check(page.locator(".page").count() == 8 and page.locator("#page-ind").inner_text().strip() == "3 / 8", "'Add blank page' puts one after the current page")

    # Saving with notes includes the blank pages and their writing.
    with page.expect_download() as dl:
        page.locator("#export").click()
    out = S + "tools_export.pdf"
    dl.value.save_as(out)
    annots = json.loads(subprocess.run(["node", str(ROOT / "tests/count_annotations.mjs"), out], capture_output=True, text=True, check=True).stdout)
    pages_out = subprocess.run(["node", "-e", f"import('{(ROOT / 'web/vendor/pdf-lib/pdf-lib.esm.min.js').as_posix()}').then(async m => {{ const d = await m.PDFDocument.load(require('fs').readFileSync('{out}')); console.log(d.getPageCount()); }})"], capture_output=True, text=True).stdout.strip()
    check(pages_out == "8", f"the saved PDF has 8 pages ({pages_out})")
    check(any(a["page"] == 1 for a in annots), f"the writing on the blank page is on page 2 of the saved PDF {[a['page'] for a in annots]}")

    # Removing a blank page (it has writing, so it asks first; the dialog is accepted).
    page.locator("#thumbs .thumb").nth(1).locator(".thumb-more").click()
    page.locator(".menu [data-action=remove-blank]").click()
    settle(900)
    data = ink()
    check(page.locator(".page").count() == 7 and len(data["pages"]) == 1, "removed the blank page")
    check(not any(str(s["page"]).startswith("b:" + blank_ids[0]) for s in data["strokes"]), "its writing went with it")
    page.locator("#pp-close").click()
    settle()
    check(page.locator("#pages-panel").is_hidden() and page.locator(".page").first.bounding_box()["x"] < 252, "closing the panel gives the space back")

    # Reopening the document keeps the blank page.
    page.locator("#back").click()
    page.wait_for_selector("#library:not([hidden])")
    page.locator(".doc-open").first.click()
    page.wait_for_selector("#reader:not([hidden])")
    settle(1000)
    check(page.locator(".page").count() == 7, "the blank page is still there after reopening")

    check(not errors, f"no page errors {errors}")
    b.close()

srv.shutdown()
print("\nFAILED:" if fails else "\nALL PASSED", fails)
sys.exit(1 if fails else 0)
