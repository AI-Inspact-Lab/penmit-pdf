"""End-to-end test in Chromium (Playwright for Python). Run `node tests/make_test_pdf.mjs` first."""
import http.server, socketserver, threading, json, hashlib, base64, re, sys
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
WEB = str(ROOT / "web")
S = str(ROOT / "tests" / "out") + "/"
PORT = 8791


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()


class MockRepo:
    def __init__(self, name):
        self.name = name
        self.blobs, self.trees, self.commits = {}, {}, {}
        self.head = None
        self.fail_next_patch = False
        self.calls = []

    def blob(self, data):
        sha = hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()
        self.blobs[sha] = data
        return sha

    def tree(self, entries):
        sha = hashlib.sha1(json.dumps(sorted(entries.items())).encode()).hexdigest()
        self.trees[sha] = dict(entries)
        return sha

    def commit(self, tree, parents, msg):
        sha = hashlib.sha1(json.dumps([tree, parents, msg, len(self.commits)]).encode()).hexdigest()
        self.commits[sha] = {"tree": tree, "parents": parents, "message": msg}
        return sha

    def files(self):
        return self.trees[self.commits[self.head]["tree"]] if self.head else {}

    def read(self, path):
        return self.blobs[self.files()[path]]


repos = {"me/notes": MockRepo("notes"), "me/other": MockRepo("other")}
CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-GitHub-Api-Version",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "Access-Control-Expose-Headers": "x-ratelimit-remaining"}


def handle(route, request):
    u = urlparse(request.url)
    method = request.method

    def reply(status, body=None):
        route.fulfill(status=status, headers={**CORS, "Content-Type": "application/json"}, body=json.dumps(body) if body is not None else "")

    if method == "OPTIONS":
        return route.fulfill(status=204, headers=CORS, body="")
    if request.headers.get("authorization") != "Bearer testtoken":
        return reply(401, {"message": "Bad credentials"})
    m = re.match(r"^/repos/([^/]+)/([^/]+)(.*)$", u.path)
    if not m or f"{m[1]}/{m[2]}" not in repos:
        return reply(404, {"message": "Not Found"})
    repo = repos[f"{m[1]}/{m[2]}"]
    rest = m[3]
    body = json.loads(request.post_data) if request.post_data else None
    repo.calls.append(f"{method} {rest}")
    if rest == "" and method == "GET":
        return reply(200, {"full_name": f"{m[1]}/{m[2]}", "private": True, "default_branch": "main"})
    if rest == "/git/ref/heads/main":
        return reply(409, {"message": "Git Repository is empty."}) if not repo.head else reply(200, {"object": {"sha": repo.head}})
    if rest == "/contents/README.md" and method == "PUT":
        b = repo.blob(base64.b64decode(body["content"]))
        entries = dict(repo.files()); entries["README.md"] = b
        repo.head = repo.commit(repo.tree(entries), [repo.head] if repo.head else [], body["message"])
        return reply(201, {"commit": {"sha": repo.head}})
    mm = re.match(r"^/git/commits/([0-9a-f]+)$", rest)
    if mm and method == "GET":
        c = repo.commits[mm[1]]
        return reply(200, {"sha": mm[1], "tree": {"sha": c["tree"]}})
    mm = re.match(r"^/git/trees/([0-9a-f]+)$", rest)
    if mm and method == "GET":
        t = repo.trees[mm[1]]
        return reply(200, {"sha": mm[1], "truncated": False, "tree": [{"path": p, "type": "blob", "sha": s, "mode": "100644"} for p, s in t.items()]})
    mm = re.match(r"^/git/blobs/([0-9a-f]+)$", rest)
    if mm and method == "GET":
        enc = base64.b64encode(repo.blobs[mm[1]]).decode()
        return reply(200, {"sha": mm[1], "encoding": "base64", "content": "\n".join(enc[i:i + 60] for i in range(0, len(enc), 60))})
    if rest == "/git/blobs" and method == "POST":
        return reply(201, {"sha": repo.blob(base64.b64decode(body["content"]))})
    if rest == "/git/trees" and method == "POST":
        entries = dict(repo.trees[body["base_tree"]])
        for e in body["tree"]:
            if e["sha"] is None: entries.pop(e["path"], None)
            else: entries[e["path"]] = e["sha"]
        return reply(201, {"sha": repo.tree(entries)})
    if rest == "/git/commits" and method == "POST":
        return reply(201, {"sha": repo.commit(body["tree"], body["parents"], body["message"])})
    if rest == "/git/refs/heads/main" and method == "PATCH":
        if repo.fail_next_patch:
            repo.fail_next_patch = False
            # someone else pushed: advance head with an unrelated commit first
            entries = dict(repo.files()); entries["other.txt"] = repo.blob(b"hello")
            repo.head = repo.commit(repo.tree(entries), [repo.head], "other device")
            return reply(422, {"message": "Update is not a fast forward"})
        if repo.commits[body["sha"]]["parents"] != [repo.head]:
            return reply(422, {"message": "Update is not a fast forward"})
        repo.head = body["sha"]
        return reply(200, {"object": {"sha": repo.head}})
    return reply(404, {"message": f"unmocked {method} {rest}"})


READ_INK = """async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('penmit'); r.onsuccess = () => res(r.result); });
  const get = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
  const ink = await get('ink'), docs = await get('docs');
  db.close();
  return { docs: docs.map(d => ({ name: d.name, deleted: !!d.deleted, synced: !!d.synced })), ink: ink.map(i => ({ strokes: Object.keys(i.strokes).sort(), deleted: Object.keys(i.deleted).sort() })) };
}"""

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)


def device(browser, name):
    ctx = browser.new_context(viewport={"width": 1100, "height": 850}, locale="ko-KR")
    ctx.route("https://api.github.com/**", handle)
    page = ctx.new_page()
    page.on("pageerror", lambda e: print(f"[{name}] PAGEERROR", e))
    page.goto(f"http://localhost:{PORT}/")
    page.wait_for_selector("#library:not([hidden])")
    page.cdp = ctx.new_cdp_session(page)
    return page


def configure(page, repo="notes"):
    page.locator("#lib-settings").click()
    page.fill("input[name=owner]", "me")
    page.fill("input[name=repo]", repo)
    page.fill("input[name=token]", "testtoken")
    page.locator("#test-github").click()
    page.wait_for_function("() => document.querySelector('#github-status').classList.contains('ok')", timeout=5000)
    status = page.locator("#github-status").inner_text()
    page.locator("button[value=save]").click()
    return status


def do_sync(page):
    btn = "#reader-sync" if page.locator("#reader").is_visible() else "#lib-sync"
    page.locator(btn).click()
    page.wait_for_function("(sel) => !document.querySelector(sel).disabled && !document.querySelector(sel).classList.contains('spin')", arg=btn, timeout=20000)
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


def remote_ink(repo="notes"):
    r = repos[f"me/{repo}"]
    paths = [p for p in r.files() if p.endswith("ink.json")]
    if not paths: return None
    data = json.loads(r.read(paths[0]))
    return {"strokes": sorted(data["strokes"]), "deleted": sorted(data["deleted"])}


with sync_playwright() as p:
    b = p.chromium.launch()
    A = device(b, "A")
    B = device(b, "B")

    # A: add a PDF, write, connect, sync to an empty repository.
    A.set_input_files("#file-input", S + "test.pdf")
    A.wait_for_selector("#reader:not([hidden])")
    A.wait_for_timeout(800)
    pen(A, 0, 0.2, 0.3)
    status = configure_status = None
    A.locator("#back").click()
    A.wait_for_selector("#library:not([hidden])")
    status = configure(A)
    check("me/notes" in status and "비공개" in status, f"connection test: {status}")
    toast = do_sync(A)
    files = sorted(repos["me/notes"].files())
    check(any(f.endswith("document.pdf") for f in files) and any(f.endswith("ink.json") for f in files) and "README.md" in files, f"A uploaded files {files}")
    s1 = A.evaluate(READ_INK)["ink"][0]["strokes"]
    check(remote_ink()["strokes"] == s1 and len(s1) == 1, "remote ink has A's stroke")
    check(A.evaluate(READ_INK)["docs"][0]["synced"], "A's doc marked as synced")

    # B: connect and sync; gets the PDF with A's stroke.
    configure(B)
    do_sync(B)
    st = B.evaluate(READ_INK)
    check(len(st["docs"]) == 1 and st["ink"][0]["strokes"] == s1, f"B downloaded the PDF and ink {st}")
    B.wait_for_timeout(600)
    check(B.locator(".doc").count() == 1, "B's library shows the PDF")

    # B: draw s2, erase s1, sync from inside the reader.
    B.locator(".doc-open").first.click()
    B.wait_for_selector("#reader:not([hidden])")
    B.wait_for_timeout(900)
    pen(B, 0, 0.5, 0.6)
    B.locator("[data-tool=eraser]").click()
    bx = B.locator(".page").nth(0).bounding_box()
    x, y0 = bx["x"] + bx["width"] * 0.2 + 40, bx["y"] + bx["height"] * 0.3 - 20
    B.cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y0, "button": "left", "buttons": 1, "clickCount": 1, "pointerType": "pen", "force": 0.5})
    for i in range(12):
        B.cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y0 + i * 4, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.5})
    B.cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y0 + 48, "button": "left", "buttons": 0, "clickCount": 1, "pointerType": "pen"})
    B.wait_for_timeout(600)
    do_sync(B)
    rb = remote_ink()
    check(len(rb["strokes"]) == 1 and rb["strokes"] != s1 and rb["deleted"] == s1, f"remote now has B's stroke only, A's tombstoned {rb}")

    # A and B both write offline, B syncs first, then A: both strokes survive.
    A.locator(".doc-open").first.click()
    A.wait_for_selector("#reader:not([hidden])")
    A.wait_for_timeout(900)
    B.locator("[data-tool=pen]").click()
    pen(A, 1, 0.3, 0.3)
    pen(B, 2, 0.3, 0.3)
    do_sync(B)
    repos["me/notes"].fail_next_patch = True  # A's push races another device once
    toast = do_sync(A)
    check("동기화했어요" in toast, f"A sync after a race: {toast}")
    a_ink = A.evaluate(READ_INK)["ink"][0]
    r = remote_ink()
    check(len(a_ink["strokes"]) == 3 and a_ink["strokes"] == r["strokes"] and s1[0] in a_ink["deleted"], f"A merged: {len(a_ink['strokes'])} strokes, s1 deleted, matches remote")
    page_strokes = A.evaluate("() => window.penmit && 1")
    do_sync(B)
    b_ink = B.evaluate(READ_INK)["ink"][0]
    check(b_ink["strokes"] == r["strokes"], "B caught up with A's offline stroke")
    check("other.txt" in repos["me/notes"].files(), "the racing device's commit was kept (no force push)")

    # Switching A to another repository uploads instead of deleting.
    A.locator("#back").click()
    A.wait_for_selector("#library:not([hidden])")
    A.wait_for_timeout(500)
    configure(A, "other")
    do_sync(A)
    check(len(A.evaluate(READ_INK)["docs"]) == 1 and any(f.endswith("document.pdf") for f in repos["me/other"].files()), "switching repository uploads, keeps local PDF")
    configure(A, "notes")
    do_sync(A)
    check(len(A.evaluate(READ_INK)["docs"]) == 1, "switching back keeps the PDF")

    # A deletes the PDF; the deletion reaches GitHub and then B.
    A.on("dialog", lambda d: d.accept())
    A.locator(".doc-del").first.click()
    A.wait_for_timeout(500)
    do_sync(A)
    check(not any(f.startswith("penmit/") for f in repos["me/notes"].files()), f"deleted from GitHub {sorted(repos['me/notes'].files())}")
    check(A.evaluate(READ_INK)["docs"] == [], "A's local marker cleaned up")
    B.locator("#back").click()
    B.wait_for_selector("#library:not([hidden])")
    B.wait_for_timeout(800)
    do_sync(B)
    check(B.evaluate(READ_INK)["docs"] == [] and B.locator(".doc").count() == 0, "B removed the PDF deleted on A")

    # Wrong token gives a clear message.
    B.locator("#lib-settings").click()
    B.fill("input[name=token]", "nope")
    B.locator("#test-github").click()
    B.wait_for_function("() => document.querySelector('#github-status').classList.contains('bad')")
    check("토큰" in B.locator("#github-status").inner_text(), f"bad token message: {B.locator('#github-status').inner_text()}")
    B.locator("button[value=cancel]").last.click()
    b.close()

srv.shutdown()
print("\nFAILED:" if fails else "\nALL PASSED", fails)
sys.exit(1 if fails else 0)
