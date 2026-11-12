"""A new version of the web app arrives whole: after an update the page never runs old code with
new markup (or the reverse), and the app still opens offline.
Runs against a copy of web/ in tests/out/site that the test changes to play a new release."""
import http.server, socketserver, threading, shutil, sys, re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "tests" / "out" / "site"
PORT = 8799
shutil.rmtree(SITE, ignore_errors=True)
shutil.copytree(ROOT / "web", SITE)


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    def __init__(self, *a, **k): super().__init__(*a, directory=str(SITE), **k)
    def end_headers(self):
        self.send_header("Cache-Control", "max-age=600")  # like GitHub Pages
        super().end_headers()
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)


def edit(rel, pattern, repl):
    f = SITE / rel
    text = f.read_text(encoding="utf-8")
    new = re.sub(pattern, repl, text, count=1)
    assert new != text, (rel, pattern)
    f.write_text(new, encoding="utf-8")


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(locale="ko-KR")
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://localhost:{PORT}/")
    page.wait_for_selector("#library:not([hidden])")
    page.wait_for_function("() => navigator.serviceWorker.controller", timeout=10000)
    check(page.locator(".lib-title h1").inner_text() == "문서", "first version")

    # A new release changes the markup and the code together.
    edit("index.html", r'<h1 data-i18n="library"></h1>', '<h1 data-i18n="library" data-release="2"></h1>')
    edit("src/i18n.js", r'library: "문서",', 'library: "문서함",')
    edit("sw.js", r'const VERSION = "penmit-[^"]+";', 'const VERSION = "penmit-test-2";')
    page.reload()
    page.wait_for_function("() => document.querySelector('.lib-title h1')?.textContent")
    first = page.evaluate("(() => { const h = document.querySelector('.lib-title h1'); return [h.textContent, h.dataset.release || ''] })()")
    check(first == ["문서함", "2"], f"one reload gets the new markup and the new code together {first}")
    page.wait_for_timeout(2500)  # the new worker takes over and the app reloads itself once
    page.wait_for_function("() => document.querySelector('.lib-title h1')?.textContent")
    after = page.evaluate("(() => { const h = document.querySelector('.lib-title h1'); return [h.textContent, h.dataset.release || ''] })()")
    check(after == ["문서함", "2"], f"still the new version after the new worker takes over {after}")
    names = page.evaluate("caches.keys()")
    check(names == ["penmit-test-2"], f"only the new version is cached {names}")

    # Offline, the app still opens from the cache.
    ctx.set_offline(True)
    page.reload()
    page.wait_for_selector("#library:not([hidden])", timeout=10000)
    check(page.locator(".lib-title h1").inner_text() == "문서함", "opens offline with the cached new version")
    ctx.set_offline(False)

    check(not errors, f"no page errors {errors}")
    b.close()

srv.shutdown()
print("\nFAILED:" if fails else "\nALL PASSED", fails)
sys.exit(1 if fails else 0)
