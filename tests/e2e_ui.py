"""End-to-end test in Chromium (Playwright for Python). Run `node tests/make_test_pdf.mjs` first."""
import http.server, socketserver, threading, json, subprocess, sys, time
from playwright.sync_api import sync_playwright

from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
WEB = str(ROOT / "web")
S = str(ROOT / "tests" / "out") + "/"
PORT = 8790


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
                      ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml"}

    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

READ_INK = """async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('penmit'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = await new Promise((res) => { const q = db.transaction('ink').objectStore('ink').getAll(); q.onsuccess = () => res(q.result); });
  db.close();
  return all.map(i => ({ id: i.id.slice(0, 8), n: Object.keys(i.strokes).length, d: Object.keys(i.deleted).length,
    strokes: Object.values(i.strokes).map(s => ({ tool: s.tool, page: s.page, np: s.pts.length / 3, p: s.pts[2], w: s.width, c: s.color })) }));
}"""

fails = []


def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        fails.append(msg)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="ko-KR", accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type in ("error",) else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://localhost:{PORT}/")
    page.wait_for_selector("#library:not([hidden])")
    check(page.locator("#lib-empty").is_visible(), "empty library shows the empty message")
    page.screenshot(path=S + "01_library_empty.png")

    page.set_input_files("#file-input", S + "test.pdf")
    page.wait_for_selector("#reader:not([hidden])", timeout=15000)
    page.wait_for_function("() => { const c = document.querySelector('.page canvas.pdf'); return c && c.width > 0; }", timeout=15000)
    check(page.locator(".page").count() == 6, "six pages laid out")
    check(page.locator("#page-ind").inner_text().strip() == "1 / 6", "page indicator shows 1 / 6")
    page.wait_for_timeout(400)
    page.screenshot(path=S + "02_reader.png")

    cdp = ctx.new_cdp_session(page)

    def stroke(points, ptype="pen", force=0.6):
        x0, y0 = points[0]
        cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "clickCount": 1, "pointerType": ptype, "force": force})
        for (x, y) in points[1:]:
            cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1, "pointerType": ptype, "force": force})
        x1, y1 = points[-1]
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x1, "y": y1, "button": "left", "buttons": 0, "clickCount": 1, "pointerType": ptype, "force": 0})
        page.wait_for_timeout(80)

    def zig(box, fx, fy, w=160, h=40, n=24):
        x0 = box["x"] + box["width"] * fx
        y0 = box["y"] + box["height"] * fy
        return [(x0 + w * i / n, y0 + (h if i % 2 else 0)) for i in range(n + 1)]

    p1 = page.locator(".page").nth(0).bounding_box()
    stroke(zig(p1, 0.15, 0.3), "pen", 0.8)
    page.wait_for_timeout(600)
    ink = page.evaluate(READ_INK)
    check(ink and ink[0]["n"] == 1 and ink[0]["strokes"][0]["tool"] == "pen", f"pen stroke saved {ink}")
    check(abs(ink[0]["strokes"][0]["p"] - 0.8) < 0.05, "pen pressure recorded")

    # A finger does not draw while 'draw with a finger' is off.
    cx, cy = p1["x"] + 300, p1["y"] + 400
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": cx, "y": cy}]})
    for i in range(1, 8):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": cx + i * 10, "y": cy + i * 4}]})
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait_for_timeout(600)
    check(page.evaluate(READ_INK)[0]["n"] == 1, "finger touch did not draw")

    # Mouse draws too, in blue and thick.
    page.locator(".swatch").nth(1).click()
    page.locator(".width").nth(2).click()
    stroke(zig(p1, 0.15, 0.45, 200, 30), "mouse")
    page.locator("[data-tool=highlighter]").click()
    stroke([(p1["x"] + p1["width"] * 0.12 + i * 12, p1["y"] + p1["height"] * 0.172) for i in range(30)], "pen", 0.5)
    page.wait_for_timeout(600)
    ink = page.evaluate(READ_INK)[0]
    tools = sorted(s["tool"] for s in ink["strokes"])
    check(ink["n"] == 3 and tools == ["highlighter", "pen", "pen"], f"three strokes incl. highlighter {tools}")
    blue = [s for s in ink["strokes"] if s["c"] == "#2453c9"]
    check(blue and blue[0]["w"] == 3.2, "colour and thickness applied")
    page.screenshot(path=S + "03_drawn.png")

    # Eraser removes the first zigzag; undo brings it back.
    page.locator("[data-tool=eraser]").click()
    stroke([(p1["x"] + p1["width"] * 0.15 + 80, p1["y"] + p1["height"] * 0.3 - 30 + i * 6) for i in range(20)], "pen", 0.5)
    page.wait_for_timeout(600)
    ink = page.evaluate(READ_INK)[0]
    check(ink["n"] == 2 and ink["d"] == 1, f"eraser removed one stroke (n={ink['n']} d={ink['d']})")
    page.locator("#undo").click()
    page.wait_for_timeout(600)
    ink = page.evaluate(READ_INK)[0]
    check(ink["n"] == 3, "undo restored the erased stroke")
    page.locator("#redo").click()
    page.wait_for_timeout(300)
    page.locator("#undo").click()
    page.wait_for_timeout(600)
    check(page.evaluate(READ_INK)[0]["n"] == 3, "redo then undo keeps three strokes")

    # Layouts.
    page.locator("[data-layout=double]").click()
    page.wait_for_timeout(300)
    check(page.locator(".page-row").count() == 3, "two-page layout has 3 rows")
    page.screenshot(path=S + "04_double.png")
    page.locator("[data-layout=cover]").click()
    page.wait_for_timeout(300)
    rows = page.evaluate("[...document.querySelectorAll('.page-row')].map(r => r.children.length)")
    check(rows == [1, 2, 2, 1], f"cover layout rows {rows}")
    page.locator("[data-layout=single]").click()
    page.wait_for_timeout(300)
    page.locator("#zoom-in").click()
    page.wait_for_timeout(300)
    check(page.locator("#zoom-fit").inner_text() == "125%", "zoom in to 125%")
    page.locator("#zoom-fit").click()
    page.wait_for_timeout(300)

    # Draw on the rotated page 5 and the landscape page 4.
    page.locator("[data-tool=pen]").click()
    page.locator(".swatch").nth(2).click()
    page.locator(".width").nth(1).click()
    for idx in (3, 4):
        page.evaluate(f"document.querySelectorAll('.page')[{idx}].scrollIntoView()")
        page.wait_for_timeout(500)
        bx = page.locator(".page").nth(idx).bounding_box()
        stroke(zig(bx, 0.2, 0.2, 120, 50, 12), "pen", 0.6)
    page.wait_for_timeout(600)
    ink = page.evaluate(READ_INK)[0]
    check(sorted({s["page"] for s in ink["strokes"]}) == [0, 3, 4], f"strokes on pages {sorted({s['page'] for s in ink['strokes']})}")
    page.evaluate("document.querySelectorAll('.page')[4].scrollIntoView()")
    page.wait_for_timeout(500)
    page.locator(".page").nth(4).screenshot(path=S + "05_rotated_screen.png")

    # Export.
    with page.expect_download() as dl:
        page.locator("#export").click()
    out = S + "out.pdf"
    dl.value.save_as(out)
    check(dl.value.suggested_filename.endswith("(Penmit).pdf"), f"export file name {dl.value.suggested_filename}")

    # Back to the library: thumbnail and metadata.
    page.locator("#back").click()
    page.wait_for_selector("#library:not([hidden])")
    page.wait_for_timeout(500)
    check(page.locator(".doc").count() == 1, "library lists the PDF")
    page.screenshot(path=S + "06_library.png")

    # Re-open restores layout/zoom/page state and ink.
    page.locator(".doc-open").first.click()
    page.wait_for_selector("#reader:not([hidden])")
    page.wait_for_timeout(800)
    check(page.evaluate("document.querySelectorAll('.page canvas.ink')[0] !== null"), "reader reopened")
    page.locator("#back").click()

    # Import the exported PDF to see the annotations rendered by pdf.js (as other readers would).
    page.set_input_files("#file-input", out)
    page.wait_for_selector("#reader:not([hidden])", timeout=15000)
    page.wait_for_timeout(1200)
    page.locator(".page").nth(0).screenshot(path=S + "07_export_p1.png")
    page.evaluate("document.querySelectorAll('.page')[4].scrollIntoView()")
    page.wait_for_timeout(900)
    page.locator(".page").nth(4).screenshot(path=S + "08_export_rotated.png")

    errs = [e for e in errors if "favicon" not in e]
    check(not errs, f"no console errors {errs}")
    b.close()

# Validate the exported PDF structure with pdf-lib.
res = subprocess.run(["node", str(ROOT / "tests" / "count_annotations.mjs"), S + "out.pdf"], capture_output=True, text=True)
annots = json.loads(res.stdout or "[]")
print(res.stderr[:500])
check(len(annots) == 5 and all(a["sub"] == "/Ink" and a["ap"] for a in annots), f"export has 5 ink annotations with appearances: {annots}")
check(any(a["ca"] == "0.35" for a in annots), "highlighter exported with 0.35 opacity")
srv.shutdown()
print("\nFAILED:" if fails else "\nALL PASSED", fails)
sys.exit(1 if fails else 0)
