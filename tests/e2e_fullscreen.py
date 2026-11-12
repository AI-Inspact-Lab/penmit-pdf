"""Full screen (two pages per screen, finger turns pages, pen writes) and go to page, on a touch tablet.
Run `node tests/make_test_pdf.mjs` first."""
import http.server, socketserver, threading, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WEB = str(ROOT / "web")
S = str(ROOT / "tests" / "out") + "/"
PORT = 8794


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

STROKES = """async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('penmit'); r.onsuccess = () => res(r.result); });
  const all = await new Promise((res) => { const q = db.transaction('ink').objectStore('ink').getAll(); q.onsuccess = () => res(q.result); });
  db.close();
  return all.reduce((n, i) => n + Object.keys(i.strokes).length, 0);
}"""

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1180, "height": 820}, is_mobile=False, has_touch=True, locale="ko-KR")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://localhost:{PORT}/")
    page.wait_for_selector("#library:not([hidden])")
    cdp = ctx.new_cdp_session(page)
    ind = lambda: page.locator("#page-ind").inner_text().strip()

    def settle(ms=900):
        page.wait_for_timeout(ms)

    def finger(points):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": points[0][0], "y": points[0][1]}]})
        for x, y in points[1:]:
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    def pen(points):
        x0, y0 = points[0]
        cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "clickCount": 1, "pointerType": "pen", "force": 0.6})
        for x, y in points[1:]:
            cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.6})
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": points[-1][0], "y": points[-1][1], "button": "left", "buttons": 0, "clickCount": 1, "pointerType": "pen"})

    page.set_input_files("#file-input", S + "test.pdf")
    page.wait_for_selector("#reader:not([hidden])")
    settle(1200)

    # Go to page from the page counter.
    check(ind() == "1 / 6", f"counter starts at 1 / 6 ({ind()})")
    page.locator("#page-ind").click()
    check(page.locator("#goto").is_visible(), "tapping the counter asks for a page")
    page.locator("#goto input").fill("4")
    page.locator("#goto button[value=ok]").click()
    settle()
    check(ind() == "4 / 6", f"jumped to page 4 ({ind()})")
    page.locator("#page-ind").click()
    page.locator("#goto input").fill("99")
    page.keyboard.press("Enter")
    settle()
    check(ind() == "6 / 6", f"a page past the end goes to the last page ({ind()})")

    # Two pages, then full screen.
    page.locator("#view-btn").click()
    page.locator("[data-layout=double]").click()
    page.locator("#view-btn").click()
    page.locator("#zoom-in").click()
    page.keyboard.press("Escape")
    zoom_before = page.locator("#zoom-fit").inner_text()
    page.locator("#page-ind").click()
    page.locator("#goto input").fill("1")
    page.locator("#goto button[value=ok]").click()
    settle()
    page.locator("#fullscreen").click()
    settle(1200)
    check(page.locator(".reader-nav").is_hidden() and page.locator("#toolbar").is_hidden(), "full screen hides the bars")
    vp = page.viewport_size
    boxes = [page.locator(".page").nth(i).bounding_box() for i in (0, 1)]
    inside = all(bx["x"] >= -1 and bx["y"] >= -1 and bx["x"] + bx["width"] <= vp["width"] + 1 and bx["y"] + bx["height"] <= vp["height"] + 1 for bx in boxes)
    check(inside and abs(boxes[0]["y"] - boxes[1]["y"]) < 2, f"pages 1 and 2 fit on the screen side by side {boxes}")
    third = page.locator(".page").nth(2).bounding_box()
    check(third["y"] >= vp["height"] - 1, "page 3 is not on the screen")
    check(ind() == "1 / 6", f"counter shows 1 / 6 ({ind()})")

    # Keyboard and finger turn two pages at a time.
    page.keyboard.press("ArrowRight")
    settle()
    check(ind() == "3 / 6", f"→ turns to pages 3-4 ({ind()})")
    cx, cy = vp["width"] / 2, vp["height"] / 2
    finger([(cx + 200 - i * 40, cy) for i in range(11)])
    settle()
    check(ind() == "5 / 6", f"a left swipe turns to pages 5-6 ({ind()})")
    finger([(30, cy), (30, cy)])
    settle()
    check(ind() == "3 / 6", f"a tap near the left edge turns back ({ind()})")

    # In full screen the pen writes and the finger does not.
    before = page.evaluate(STROKES)
    bx = page.locator(".page").nth(2).bounding_box()
    pen([(bx["x"] + 80 + i * 8, bx["y"] + 200 + (8 if i % 2 else 0)) for i in range(14)])
    settle()
    check(page.evaluate(STROKES) == before + 1, "the pen writes in full screen")
    check(not page.locator("#fs-undo").is_disabled(), "undo is available in full screen")
    finger([(bx["x"] + 80, bx["y"] + 300 + i * 2) for i in range(8)])
    settle()
    check(page.evaluate(STROKES) == before + 1, "a finger does not write in full screen")
    check(ind() == "3 / 6", f"still on pages 3-4 ({ind()})")

    # Leaving full screen brings the bars and the zoom back.
    page.keyboard.press("Escape")
    settle()
    check(page.locator(".reader-nav").is_visible() and page.locator("#toolbar").is_visible(), "Escape leaves full screen")
    page.locator("#view-btn").click()
    check(page.locator("#zoom-fit").inner_text() == zoom_before, f"zoom restored ({page.locator('#zoom-fit').inner_text()} vs {zoom_before})")
    page.keyboard.press("Escape")
    page.locator("#fullscreen").click()
    settle()
    page.locator("#fs-exit").click()
    settle()
    check(page.locator(".reader-nav").is_visible(), "the exit button leaves full screen")

    check(not errors, f"no page errors {errors}")
    b.close()

srv.shutdown()
print("\nFAILED:" if fails else "\nALL PASSED", fails)
sys.exit(1 if fails else 0)
