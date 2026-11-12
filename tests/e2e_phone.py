"""A phone with only fingers, then a pen: taps, finger writing, scrolling, and the switch to pen-only.
Run `node tests/make_test_pdf.mjs` first."""
import http.server, socketserver, threading, json, sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WEB = str(ROOT / "web")
S = str(ROOT / "tests" / "out") + "/"
PORT = 8793


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
    iphone = p.devices["iPhone 13"]
    ctx = b.new_context(viewport=iphone["viewport"], device_scale_factor=iphone["device_scale_factor"],
                        user_agent=iphone["user_agent"], is_mobile=True, has_touch=True, locale="ko-KR")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://localhost:{PORT}/")
    page.wait_for_selector("#library:not([hidden])")
    cdp = ctx.new_cdp_session(page)

    def stroke_count():
        page.wait_for_timeout(700)
        return page.evaluate(STROKES)

    def finger(points, fingers=1):
        def tp(x, y):
            return [{"x": x + 60 * k, "y": y, "id": k} for k in range(fingers)]
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": tp(*points[0])})
        for x, y in points[1:]:
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": tp(x, y)})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    def pen(points):
        x0, y0 = points[0]
        cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "clickCount": 1, "pointerType": "pen", "force": 0.6})
        for x, y in points[1:]:
            cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.6})
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": points[-1][0], "y": points[-1][1], "button": "left", "buttons": 0, "clickCount": 1, "pointerType": "pen"})

    def zig(fy, fx=0.2):
        bx = page.locator(".page").first.bounding_box()
        x0, y0 = bx["x"] + bx["width"] * fx, bx["y"] + bx["height"] * fy
        return [(x0 + i * 8, y0 + (10 if i % 2 else 0)) for i in range(14)]

    page.set_input_files("#file-input", S + "test.pdf")
    page.wait_for_selector("#reader:not([hidden])")
    page.wait_for_timeout(1200)

    # Taps on the toolbar work.
    page.tap(".tool[data-tool=highlighter]")
    check(page.locator(".tool[data-tool=highlighter]").get_attribute("aria-checked") == "true", "tapping the highlighter selects it")
    page.tap(".tool[data-tool=pen]")
    check(page.locator(".tool[data-tool=pen]").get_attribute("aria-checked") == "true", "tapping the pen selects it")
    check(page.locator("#palette").is_visible(), "colors and sizes show for the pen")

    # A phone that has never seen a pen: one finger writes.
    finger(zig(0.2))
    check(stroke_count() == 1, "a finger writes on a phone that has never used a pen")

    # Two fingers never write (they move and zoom the page).
    finger(zig(0.35), fingers=2)
    check(stroke_count() == 1, "two fingers do not write")

    # Hand tool: a finger moves the page instead of writing.
    page.tap(".tool[data-tool=hand]")
    check(page.locator("#palette").is_hidden(), "colors and sizes hide for the hand tool")
    touch_action = page.evaluate("getComputedStyle(document.querySelector('.page')).touchAction")
    check(touch_action in ("pan-x pan-y", "pan-y pan-x"), f"the page scrolls with a finger in hand mode ({touch_action})")
    finger(zig(0.5))
    check(stroke_count() == 1, "the hand tool does not write")

    # Using a pen once: the pen writes and the finger stops writing.
    page.tap(".tool[data-tool=pen]")
    pen(zig(0.6))
    check(stroke_count() == 2, "the pen writes")
    toast = page.locator("#toast").inner_text()
    check("펜이 감지" in toast, f"tells the user about the switch: {toast}")
    finger(zig(0.75))
    check(stroke_count() == 2, "after a pen is used, a finger no longer writes")

    # The setting shows the new state and can turn finger writing back on for good.
    page.tap("#back")
    page.wait_for_selector("#library:not([hidden])")
    page.tap("#lib-settings")
    switch = page.locator("input[name=fingerDraw]")
    check(not switch.is_checked(), "the switch shows finger writing is off")
    switch.tap()
    page.tap("#settings button[value=save]")
    page.wait_for_timeout(300)
    mode = page.evaluate("JSON.parse(localStorage.getItem('penmit.settings')).fingerMode")
    check(mode == "on", f"turning it on is remembered ({mode})")
    page.locator(".doc-open").first.tap()
    page.wait_for_selector("#reader:not([hidden])")
    page.wait_for_timeout(900)
    finger(zig(0.3, 0.5))
    check(stroke_count() == 3, "a finger writes again after turning it on")

    check(not errors, f"no page errors {errors}")
    b.close()

srv.shutdown()
print("\nFAILED:" if fails else "\nALL PASSED", fails)
sys.exit(1 if fails else 0)
