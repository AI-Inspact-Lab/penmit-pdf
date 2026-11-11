// Google Drive storage: a "Penmit PDF" folder in the user's own Drive, one subfolder per PDF
// (named by its SHA-256) holding document.pdf, meta.json and ink.json. With the drive.file
// scope the app sees only what it created there. Each file carries its content hash in
// appProperties, so unchanged files are recognised without downloading them.
import { StorageError, gitBlobSha } from "./sync.js";
import { googleAuth } from "./googleauth.js";
import { isDesktop } from "./platform.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const ROOT_NAME = "Penmit PDF";
const MIME = { "document.pdf": "application/pdf", "meta.json": "application/json", "ink.json": "application/json" };
const RESUMABLE_OVER = 4 * 1024 * 1024;

// The desktop app sends Drive requests from its main process, because its app:// pages are
// not a web origin that Google's cross-origin rules are written for.
async function send(url, init) {
  if (!isDesktop) return fetch(url, init);
  let body = init.body ?? null;
  if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
  else if (typeof body === "string") body = new TextEncoder().encode(body);
  const r = await window.penmitDesktop.google.fetch(url, { method: init.method, headers: init.headers, body });
  return new Response([204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, headers: r.headers });
}

export class DriveBackend {
  constructor(auth = googleAuth) {
    this.auth = auth;
    this.key = null;
  }

  async request(url, { method = "GET", headers = {}, body, json = true, retried = false } = {}) {
    const token = await this.auth.token();
    let res;
    try {
      res = await send(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body, cache: "no-store" });
    } catch (e) {
      throw new StorageError(0, e.message);
    }
    if (res.status === 401 && !retried) {
      this.auth.invalidate(); // expired: the desktop app refreshes; the web app asks to sign in again
      return this.request(url, { method, headers, body, json, retried: true });
    }
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const reason = data?.error?.errors?.[0]?.reason || "";
      throw new StorageError(/rateLimit/i.test(reason) ? 429 : res.status, data?.error?.message);
    }
    if (!json) return res;
    return res.status === 204 ? null : res.json();
  }

  async account() {
    const about = await this.request(`${API}/about?fields=user(emailAddress,displayName)`);
    return about.user || {};
  }

  async list(q, fields = "id,name,mimeType,parents,appProperties") {
    const out = [];
    let pageToken = "";
    do {
      const u = new URL(`${API}/files`);
      u.search = new URLSearchParams({
        q, fields: `nextPageToken,files(${fields})`, pageSize: "1000", spaces: "drive",
        ...(pageToken ? { pageToken } : {}),
      }).toString();
      const r = await this.request(u.toString());
      out.push(...(r.files || []));
      pageToken = r.nextPageToken || "";
    } while (pageToken);
    return out;
  }

  async createFolder(name, parent) {
    const r = await this.request(`${API}/files?fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
    });
    return r.id;
  }

  async begin() {
    if (!this.key) {
      const user = await this.account();
      this.email = user.emailAddress || "";
      this.key = `gdrive:${this.email.toLowerCase()}`;
    }
    const roots = await this.list(`name = '${ROOT_NAME}' and mimeType = '${FOLDER}' and 'root' in parents and trashed = false`, "id,createdTime");
    roots.sort((a, b) => (a.createdTime || "").localeCompare(b.createdTime || ""));
    this.root = roots[0]?.id || (await this.createFolder(ROOT_NAME, "root"));

    const items = await this.list("trashed = false");
    this.folderOf = new Map();
    this.fileOf = new Map();
    const docOfFolder = new Map();
    for (const it of items) {
      if (it.mimeType === FOLDER && it.parents?.includes(this.root) && /^[0-9a-f]{64}$/.test(it.name) && !this.folderOf.has(it.name)) {
        this.folderOf.set(it.name, it.id);
        docOfFolder.set(it.id, it.name);
      }
    }
    const docs = new Map();
    for (const it of items) {
      if (it.mimeType === FOLDER || !MIME[it.name]) continue;
      const docId = docOfFolder.get(it.parents?.[0]);
      if (!docId || this.fileOf.has(`${docId}/${it.name}`)) continue;
      this.fileOf.set(`${docId}/${it.name}`, it.id);
      if (!docs.has(docId)) docs.set(docId, {});
      docs.get(docId)[it.name.split(".")[0]] = it.appProperties?.penmitSha || `drive:${it.id}`;
    }
    return { docs };
  }

  async read(docId, name) {
    const id = this.fileOf.get(`${docId}/${name}`);
    const res = await this.request(`${API}/files/${id}?alt=media`, { json: false });
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(docId, name, bytes) {
    const sha = await gitBlobSha(bytes);
    let folder = this.folderOf.get(docId);
    if (!folder) {
      folder = await this.createFolder(docId, this.root);
      this.folderOf.set(docId, folder);
    }
    const existing = this.fileOf.get(`${docId}/${name}`);
    const meta = existing
      ? { appProperties: { penmitSha: sha } }
      : { name, parents: [folder], mimeType: MIME[name], appProperties: { penmitSha: sha } };
    const id = bytes.byteLength > RESUMABLE_OVER
      ? await this.#resumable(existing, meta, bytes, MIME[name])
      : await this.#multipart(existing, meta, bytes, MIME[name]);
    this.fileOf.set(`${docId}/${name}`, id);
    return sha;
  }

  async #multipart(existing, meta, bytes, mime) {
    const boundary = `penmit${Math.random().toString(16).slice(2)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, bytes, `\r\n--${boundary}--`,
    ]);
    const url = existing ? `${UPLOAD}/files/${existing}?uploadType=multipart&fields=id` : `${UPLOAD}/files?uploadType=multipart&fields=id`;
    const r = await this.request(url, { method: existing ? "PATCH" : "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    return r.id;
  }

  async #resumable(existing, meta, bytes, mime) {
    const url = existing ? `${UPLOAD}/files/${existing}?uploadType=resumable&fields=id` : `${UPLOAD}/files?uploadType=resumable&fields=id`;
    const start = await this.request(url, {
      method: existing ? "PATCH" : "POST",
      json: false,
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime },
      body: JSON.stringify(meta),
    });
    const session = start.headers.get("Location");
    if (!session) return this.#multipart(existing, meta, bytes, mime);
    const r = await this.request(session, { method: "PUT", headers: { "Content-Type": mime }, body: bytes });
    return r.id;
  }

  // Into Drive's bin, so a mistaken delete can still be undone from drive.google.com.
  async remove(docId) {
    const folder = this.folderOf.get(docId);
    if (!folder) return;
    await this.request(`${API}/files/${folder}?fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  async finish() { /* every write was already saved */ }

  version(bytes) { return gitBlobSha(bytes); }
}
