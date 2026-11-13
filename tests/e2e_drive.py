"""Google Drive sync, end to end in Chromium, against a mocked Google sign-in and Drive API.
Run `node tests/make_test_pdf.mjs` first."""
import http.server, socketserver, threading, json, hashlib, re, sys, itertools
from urllib.parse import urlparse, parse_qs
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WEB = str(ROOT / "web")
S = str(ROOT / "tests" / "out") + "/"
PORT = 8792
ORIGIN = f"http://localhost:{PORT}"


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()

FOLDER = "application/vnd.google-apps.folder"
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Upload-Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "Access-Control-Expose-Headers": "Location"}


def git_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class Drive:
    """One Google account's Drive, as far as the drive.file scope shows it."""
    def __init__(self):
        self.files = {}
        self.ids = itertools.count(1)
        self.tokens = set()
        self.sessions = {}
        self.calls = []
        self.auth_requests = []
        self.revoked = []

    def new_id(self):
        return f"f{next(self.ids):04d}"

    def trashed(self, f):
        while f:
            if f.get("trashed"): return True
            f = self.files.get(f["parents"][0]) if f.get("parents") else None
        return False

    def public(self, f):
        return {k: v for k, v in f.items() if k != "data"}

    def put(self, fid, meta, data=None):
        f = self.files.get(fid) or {"id": fid, "createdTime": f"2026-11-11T00:00:{len(self.files):02d}Z"}
        for k, v in meta.items():
            if k == "parents": f["parents"] = ["ROOT" if p == "root" else p for p in v]
            elif k == "appProperties": f["appProperties"] = {**f.get("appProperties", {}), **v}
            else: f[k] = v
        if data is not None: f["data"] = data
        self.files[fid] = f
        return f

    def tree(self):
        """{ folder name: { file name: bytes } } under the live 'Penmit PDF' folder."""
        roots = [f for f in self.files.values() if f["name"] == "Penmit PDF" and not self.trashed(f)]
        if not roots: return {}
        root = roots[0]["id"]
        out = {}
        for d in self.files.values():
            if d.get("parents") == [root] and d["mimeType"] == FOLDER and not self.trashed(d):
                out[d["name"]] = {f["name"]: f.get("data", b"") for f in self.files.values() if f.get("parents") == [d["id"]] and not self.trashed(f)}
        return out


drive = Drive()


def parse_multipart(content_type, body):
    boundary = content_type.split("boundary=")[1].strip().encode()
    parts = []
    for part in body.split(b"--" + boundary)[1:]:
        if part.startswith(b"--"): break
        _, _, content = part.partition(b"\r\n\r\n")
        parts.append(content[:-2] if content.endswith(b"\r\n") else content)
    return json.loads(parts[0]), parts[1]


def handle_google(route, request):
    u = urlparse(request.url)
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    method = request.method

    def reply(status, body=None, headers=None, raw=None):
        route.fulfill(status=status, headers={**CORS, "Content-Type": "application/json", **(headers or {})},
                      body=raw if raw is not None else (json.dumps(body) if body is not None else ""))

    if method == "OPTIONS":
        return route.fulfill(status=204, headers=CORS, body="")

    # Google's sign-in page: approve at once and go back to the app with a token in the fragment.
    if u.netloc == "accounts.google.com":
        drive.auth_requests.append(q)
        token = f"tok{len(drive.auth_requests)}"
        drive.tokens.add(token)
        back = q["redirect_uri"] + f"#access_token={token}&token_type=Bearer&expires_in=3599&scope={q['scope']}&state={q['state']}"
        return route.fulfill(status=200, headers={"Content-Type": "text/html"}, body=f"<script>location.replace({json.dumps(back)})</script>")
    if u.netloc == "oauth2.googleapis.com" and u.path == "/revoke":
        drive.revoked.append(q.get("token"))
        drive.tokens.discard(q.get("token"))
        return reply(200, {})

    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer ") or auth[7:] not in drive.tokens:
        return reply(401, {"error": {"code": 401, "message": "Invalid Credentials", "errors": [{"reason": "authError"}]}})
    body = request.post_data_buffer or b""
    path = u.path
    drive.calls.append(f"{method} {path}?{u.query}")

    if path == "/drive/v3/about":
        return reply(200, {"user": {"emailAddress": "Penmit.Tester@example.com", "displayName": "Tester"}})
    if path == "/drive/v3/files" and method == "GET":
        query = q.get("q", "")
        live = [f for f in drive.files.values() if not drive.trashed(f)]
        m = re.match(r"^name = '([^']+)' and mimeType = '([^']+)' and 'root' in parents and trashed = false$", query)
        if m:
            live = [f for f in live if f["name"] == m[1] and f["mimeType"] == m[2] and f.get("parents") == ["ROOT"]]
        elif query != "trashed = false":
            return reply(400, {"error": {"message": f"unmocked query {query}"}})
        return reply(200, {"files": [drive.public(f) for f in live]})
    if path == "/drive/v3/files" and method == "POST":
        f = drive.put(drive.new_id(), json.loads(body))
        return reply(200, {"id": f["id"]})
    m = re.match(r"^/drive/v3/files/(\w+)$", path)
    if m and m[1] in drive.files:
        f = drive.files[m[1]]
        if method == "GET" and q.get("alt") == "media":
            return reply(200, raw=f.get("data", b""), headers={"Content-Type": f.get("mimeType", "application/octet-stream")})
        if method == "PATCH":
            drive.put(m[1], json.loads(body))
            return reply(200, {"id": m[1]})
    m = re.match(r"^/upload/drive/v3/files(?:/(\w+))?$", path)
    if m:
        existing = m[1]
        if existing and existing not in drive.files:
            return reply(404, {"error": {"message": "File not found"}})
        kind = q.get("uploadType")
        if kind == "multipart" and method in ("POST", "PATCH"):
            meta, data = parse_multipart(request.headers["content-type"], body)
            f = drive.put(existing or drive.new_id(), meta, data)
            return reply(200, {"id": f["id"]})
        if kind == "resumable" and method in ("POST", "PATCH"):
            sid = f"s{len(drive.sessions) + 1}"
            drive.sessions[sid] = (existing, json.loads(body))
            return reply(200, {}, headers={"Location": f"https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id={sid}"})
        if kind == "resumable" and method == "PUT" and q.get("upload_id") in drive.sessions:
            existing, meta = drive.sessions.pop(q["upload_id"])
            f = drive.put(existing or drive.new_id(), meta, body)
            return reply(200, {"id": f["id"]})
    return reply(404, {"error": {"message": f"unmocked {method} {path}"}})


READ = """async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('penmit'); r.onsuccess = () => res(r.result); });
  const get = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
  const ink = await get('ink'), docs = await get('docs'), files = await get('files');
  db.close();
  return {
    docs: docs.map(d => ({ id: d.id, name: d.name, deleted: !!d.deleted, repo: d.synced ? d.synced.repo : null })),
    ink: Object.fromEntries(ink.map(i => [i.id, Object.keys(i.strokes).sort()])),
    sizes: Object.fromEntries(files.map(f => [f.id, (f.bytes || f.data || new Uint8Array()).byteLength ?? (f.bytes || f.data).size])),
  };
}"""

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)


# Stands in for desktop/preload.js: sign-in is done by the main process, and Drive requests
# go through it as {status, headers, body} (here forwarded with the page's own fetch).
FAKE_DESKTOP = """
window.penmitDesktop = {
  saveFile: async () => true,
  onOpenFiles: () => {},
  google: {
    available: async () => true,
    signIn: async () => { localStorage.setItem('desk.signed', '1'); return true; },
    token: async () => { if (!localStorage.getItem('desk.signed')) throw new Error('signed out'); return 'deskTok'; },
    invalidate: async () => {},
    signOut: async () => { localStorage.removeItem('desk.signed'); },
    fetch: async (url, init) => {
      window.__deskCalls = (window.__deskCalls || 0) + 1;
      if (init.body && !(init.body instanceof Uint8Array)) throw new Error('body must be bytes for IPC');
      const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
      const headers = {};
      for (const k of ['content-type', 'location']) if (r.headers.get(k)) headers[k] = r.headers.get(k);
      return { status: r.status, headers, body: new Uint8Array(await r.arrayBuffer()) };
    },
  },
};
"""


def device(browser, name, block_popups=False, desktop=False, auto=False):
    ctx = browser.new_context(viewport={"width": 1100, "height": 850}, locale="ko-KR")
    for host in ("https://www.googleapis.com/**", "https://accounts.google.com/**", "https://oauth2.googleapis.com/**"):
        ctx.route(host, handle_google)
    ctx.route("https://api.github.com/**", lambda r, q: r.abort())
    # These tests sync by hand; automatic sync is tested on its own.
    if not auto: ctx.add_init_script("if (!localStorage.getItem('penmit.settings')) localStorage.setItem('penmit.settings', JSON.stringify({ autoSync: false }));")
    if block_popups:
        ctx.add_init_script("window.open = () => null;")
    if desktop:
        ctx.add_init_script(FAKE_DESKTOP)
    page = ctx.new_page()
    if auto:
        page.clock.install()
    page.errors = []
    page.on("pageerror", lambda e: (page.errors.append(str(e)), print(f"[{name}] PAGEERROR", e)))
    page.goto(f"{ORIGIN}/")
    page.wait_for_selector("#library:not([hidden])")
    page.cdp = ctx.new_cdp_session(page)
    return page


def wait_status(page, cls="ok"):
    page.wait_for_function("(c) => document.querySelector('#gdrive-status').classList.contains(c)", arg=cls, timeout=10000)
    return page.locator("#gdrive-status").inner_text()


def sign_in_popup(page, save=True):
    page.locator("#lib-settings").click()
    page.locator("input[name=storage][value=gdrive]").check()
    check(page.locator("#gdrive-panel").is_visible() and not page.locator("#github-panel").is_visible(), "choosing Google Drive shows only the Drive panel")
    page.wait_for_function("() => document.querySelector('#gdrive-status').textContent.length > 0")
    check("로그인 안 됨" in page.locator("#gdrive-status").inner_text(), "not signed in yet")
    with page.expect_popup() as pop:
        page.locator("#google-sign-in").click()
    popup = pop.value
    popup.wait_for_event("close", timeout=10000)
    status = wait_status(page)
    page.locator("#settings button[value=save]" if save else "#settings button[value=cancel]").click()
    return status


def do_sync(page):
    btn = "#reader-sync" if page.locator("#reader").is_visible() else "#lib-sync"
    page.locator(btn).click()
    page.wait_for_function("(sel) => !document.querySelector(sel).disabled && !document.querySelector(sel).classList.contains('spin')", arg=btn, timeout=30000)
    page.wait_for_timeout(300)
    return page.locator("#toast").inner_text()


def pen(page, page_index, fx, fy):
    page.evaluate(f"document.querySelectorAll('.page')[{page_index}].scrollIntoView({{block: 'center'}})")
    page.wait_for_timeout(400)
    bx = page.locator(".page").nth(page_index).bounding_box()
    x0, y0 = bx["x"] + bx["width"] * fx, bx["y"] + bx["height"] * fy
    pts = [(x0 + i * 6, y0 + (12 if i % 2 else 0)) for i in range(16)]
    cdp = page.cdp
    cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": pts[0][0], "y": pts[0][1], "button": "left", "buttons": 1, "clickCount": 1, "pointerType": "pen", "force": 0.5})
    for x, y in pts[1:]:
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.5})
    cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": pts[-1][0], "y": pts[-1][1], "button": "left", "buttons": 0, "clickCount": 1, "pointerType": "pen"})
    page.wait_for_timeout(600)


def open_doc(page, name):
    page.locator(".doc", has_text=name).locator(".doc-open").click()
    page.wait_for_selector("#reader:not([hidden])")
    page.wait_for_timeout(900)


def back(page):
    page.locator("#back").click()
    page.wait_for_selector("#library:not([hidden])")
    page.wait_for_timeout(500)


with sync_playwright() as p:
    b = p.chromium.launch()
    A = device(b, "A")
    B = device(b, "B")

    # A: a PDF with one stroke, then sign in through the pop-up and sync.
    A.set_input_files("#file-input", S + "test.pdf")
    A.wait_for_selector("#reader:not([hidden])")
    A.wait_for_timeout(800)
    pen(A, 0, 0.2, 0.3)
    back(A)
    status = sign_in_popup(A)
    check("penmit.tester@example.com" in status.lower(), f"signed in through the pop-up: {status}")
    req = drive.auth_requests[0]
    check(req["scope"] == "https://www.googleapis.com/auth/drive.file" and req["response_type"] == "token"
          and req["redirect_uri"] == f"{ORIGIN}/" and req["client_id"].endswith(".apps.googleusercontent.com"),
          f"asks only for drive.file and comes back to the app {req['scope']} {req['redirect_uri']}")
    check(A.evaluate("JSON.parse(localStorage.getItem('penmit.settings')).storage") == "gdrive", "storage saved as Google Drive")
    toast = do_sync(A)
    check("동기화했어요" in toast, f"A synced: {toast}")
    tree = drive.tree()
    doc_id = next(iter(tree), "")
    check(len(tree) == 1 and re.fullmatch(r"[0-9a-f]{64}", doc_id) and sorted(tree[doc_id]) == ["document.pdf", "ink.json", "meta.json"],
          f"Drive has Penmit PDF/<sha256>/{{document.pdf, ink.json, meta.json}}: {[(k, sorted(v)) for k, v in tree.items()]}")
    check(tree[doc_id]["document.pdf"] == open(S + "test.pdf", "rb").read(), "the PDF on Drive is byte-for-byte the original")
    marked = [f for f in drive.files.values() if f["mimeType"] != FOLDER]
    check(all(f["appProperties"]["penmitSha"] == git_sha(f["data"]) for f in marked), "every file carries its content hash")
    a_state = A.evaluate(READ)
    check(a_state["docs"][0]["repo"] == "gdrive:penmit.tester@example.com", f"A's doc is marked as synced to this Drive: {a_state['docs'][0]['repo']}")
    s1 = a_state["ink"][doc_id]
    check(sorted(json.loads(tree[doc_id]["ink.json"])["strokes"]) == s1 and len(s1) == 1, "the stroke is on Drive")

    # A second sync with no changes uploads nothing.
    before = len([c for c in drive.calls if "/upload/" in c])
    do_sync(A)
    check(len([c for c in drive.calls if "/upload/" in c]) == before, "a sync with no changes uploads nothing")

    # B signs in with the same account and gets the PDF and the stroke.
    sign_in_popup(B)
    do_sync(B)
    st = B.evaluate(READ)
    check(len(st["docs"]) == 1 and st["ink"].get(doc_id) == s1, f"B downloaded the PDF and ink: {st['docs']}")

    # B writes, A picks it up.
    open_doc(B, "test")
    pen(B, 1, 0.4, 0.4)
    do_sync(B)
    back(B)
    do_sync(A)
    a_ink = A.evaluate(READ)["ink"][doc_id]
    check(len(a_ink) == 2 and set(s1) <= set(a_ink), f"A merged B's stroke: {len(a_ink)} strokes")
    check(len([f for f in drive.files.values() if f["name"] == "Penmit PDF"]) == 1, "only one 'Penmit PDF' folder")

    # A large PDF goes through a resumable upload and arrives intact on B.
    A.set_input_files("#file-input", S + "big.pdf")
    A.wait_for_selector("#reader:not([hidden])")
    A.wait_for_timeout(800)
    back(A)
    do_sync(A)
    big = open(S + "big.pdf", "rb").read()
    big_id = hashlib.sha256(big).hexdigest()
    check(any("uploadType=resumable" in c for c in drive.calls) and drive.tree().get(big_id, {}).get("document.pdf") == big,
          "the 5 MB PDF used a resumable upload and arrived intact")
    do_sync(B)
    check(B.locator(".doc").count() == 2, "B has both PDFs")

    # Deleting on A sends the folder to Drive's bin; B removes it too.
    A.once("dialog", lambda d: d.accept())
    A.locator(".doc", has_text="test").locator(".doc-more").click()
    A.locator(".menu [data-action=delete]").click()
    A.wait_for_timeout(500)
    do_sync(A)
    trashed = [f for f in drive.files.values() if f.get("trashed")]
    check(doc_id not in drive.tree() and len(trashed) == 1 and trashed[0]["name"] == doc_id, "the deleted PDF's folder went to Drive's bin")
    do_sync(B)
    check(B.locator(".doc").count() == 1 and len(B.evaluate(READ)["docs"]) == 1, "B removed the PDF deleted on A")

    # The token stops working (expired or revoked): a clear message, then the sign-in prompt.
    drive.tokens.clear()
    toast = do_sync(A)
    check("구글 로그인" in toast, f"expired sign-in message: {toast}")
    toast = do_sync(A)
    check("구글 로그인이 필요해요" in toast and A.locator("#settings").is_visible(), "the next sync opens settings to sign in again")
    with A.expect_popup() as pop:
        A.locator("#google-sign-in").click()
    pop.value.wait_for_event("close", timeout=10000)
    wait_status(A)
    A.locator("#settings button[value=save]").click()
    toast = do_sync(A)
    check("이미 최신이에요" in toast, f"sync works again after signing in: {toast}")

    # A browser that blocks the pop-up (and home-screen apps) signs in by leaving the page and coming back.
    C = device(b, "C", block_popups=True)
    C.locator("#lib-settings").click()
    C.locator("input[name=storage][value=gdrive]").check()
    C.locator("#google-sign-in").click()
    C.wait_for_url(re.compile(rf"^{re.escape(ORIGIN)}/$"), timeout=10000)
    C.wait_for_selector("#settings[open]", timeout=10000)
    status = wait_status(C)
    check("penmit.tester@example.com" in status.lower() and "#" not in C.url, f"redirect sign-in returns to settings, signed in, clean address: {status} {C.url}")
    C.locator("#settings button[value=save]").click()
    do_sync(C)
    check(C.locator(".doc").count() == 1, "C got the PDF from Drive")

    # Signing out forgets the token and revokes it.
    C.locator("#lib-settings").click()
    C.wait_for_selector("#google-sign-out:not([hidden])")
    C.locator("#google-sign-out").click()
    C.wait_for_function("() => !document.querySelector('#google-sign-in').hidden")
    check(C.evaluate("localStorage.getItem('penmit.google.token')") is None and len(drive.revoked) == 1, "sign-out removes and revokes the token")
    C.locator("#settings button[value=cancel]").last.click()

    # Desktop app: sign-in and Drive requests go through the main process.
    drive.tokens.add("deskTok")
    D = device(b, "D", desktop=True)
    D.locator("#lib-settings").click()
    D.locator("input[name=storage][value=gdrive]").check()
    D.locator("#google-sign-in").click()
    status = wait_status(D)
    D.locator("#settings button[value=save]").click()
    do_sync(D)
    open_doc(D, "big")
    pen(D, 0, 0.3, 0.5)
    toast = do_sync(D)
    back(D)
    check("penmit.tester@example.com" in status.lower() and D.locator(".doc").count() == 1 and D.evaluate("window.__deskCalls") > 3,
          f"desktop: signed in and synced through the main process ({D.evaluate('window.__deskCalls')} requests)")
    big_ink = json.loads(drive.tree()[big_id]["ink.json"])
    check(len(big_ink["strokes"]) == 1 and "올림" in toast, f"desktop: its stroke reached Drive: {toast}")

    # Automatic sync on the web: when the Google sign-in runs out, it says so quietly (no pop-up,
    # no error message over the page) and the sync button gets a red dot.
    # Signing in starts the first sync even when the settings are closed without "Save".
    F = device(b, "F", auto=True)
    sign_in_popup(F, save=False)
    F.clock.run_for(5_000)
    F.wait_for_function("() => document.querySelector('#sync-line').dataset.state === 'ok'", timeout=15000)
    check(F.locator(".doc").count() == 1, "automatic sync brought the PDF right after signing in, without pressing Save")
    drive.tokens.clear()
    F.locator(".doc-open").first.click()
    F.wait_for_selector("#reader:not([hidden])")
    F.wait_for_timeout(900)
    pen(F, 0, 0.5, 0.5)
    F.clock.run_for(60_000)
    F.wait_for_function("() => document.querySelector('#reader-sync').classList.contains('attention')", timeout=15000)
    check(F.locator("#toast").is_hidden() or "실패" not in F.locator("#toast").inner_text(), "no error message pops up for an automatic sync")
    F.locator("#back").click()
    F.wait_for_selector("#library:not([hidden])")
    line = F.locator("#sync-line").inner_text()
    check("구글 로그인 필요" in line and F.evaluate("document.querySelector('#sync-line').dataset.state") == "error", f"the sync line asks to sign in again ({line})")

    check(not (A.errors or B.errors or C.errors or D.errors or F.errors), f"no page errors {A.errors + B.errors + C.errors + D.errors + F.errors}")
    b.close()

srv.shutdown()
print("\nFAILED:" if fails else "\nALL PASSED", fails)
sys.exit(1 if fails else 0)
