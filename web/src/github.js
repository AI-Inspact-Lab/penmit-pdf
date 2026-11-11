// Sync with the user's own GitHub repository through the REST API, straight from the device.
//
// Layout in the repository:
//   penmit/<docId>/document.pdf   the original PDF (uploaded once; <docId> is its SHA-256)
//   penmit/<docId>/meta.json      name, page count, dates
//   penmit/<docId>/ink.json       the handwriting (small text, merges cleanly)
// Every sync is one commit made with the Git Data API (blobs, tree, commit, ref), which
// handles files up to 100 MB and changes many files atomically.

const API = "https://api.github.com";
const ROOT = "penmit";
const MAX_BLOB = 100 * 1024 * 1024;

export class GitHubError extends Error {
  constructor(status, message) {
    super(message || `GitHub ${status}`);
    this.status = status;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes]));
  });
}

export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The id Git gives a file's contents, so unchanged files are recognised without downloading them.
export async function gitBlobSha(bytes) {
  const header = enc.encode(`blob ${bytes.byteLength}\0`);
  const buf = new Uint8Array(header.length + bytes.byteLength);
  buf.set(header, 0);
  buf.set(new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength), header.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// Stable JSON, so the same ink always produces the same bytes (and the same Git blob).
export function inkToBytes(model) {
  return enc.encode(JSON.stringify({ v: 1, strokes: sortedObject(model.strokes), deleted: sortedObject(model.deleted) }));
}

export function inkFromBytes(id, bytes) {
  const data = JSON.parse(dec.decode(bytes));
  return { id, strokes: data.strokes || {}, deleted: data.deleted || {} };
}

// Union of strokes from both sides, minus anything either side deleted.
export function mergeInk(a, b) {
  const strokes = { ...a.strokes, ...b.strokes };
  const deleted = { ...a.deleted };
  for (const [k, v] of Object.entries(b.deleted)) deleted[k] = Math.max(deleted[k] || 0, v);
  for (const k of Object.keys(deleted)) delete strokes[k];
  return { id: a.id, strokes, deleted };
}

export function sameInk(a, b) {
  const ka = Object.keys(a.strokes), kb = Object.keys(b.strokes);
  const da = Object.keys(a.deleted), dbk = Object.keys(b.deleted);
  return ka.length === kb.length && da.length === dbk.length && ka.every((k) => k in b.strokes) && da.every((k) => k in b.deleted);
}

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    this.owner = owner.trim();
    this.repo = repo.trim();
    this.branch = (branch || "").trim();
    this.token = token.trim();
  }

  get base() { return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`; }

  async api(path, { method = "GET", body } = {}) {
    let res;
    try {
      res = await fetch(path.startsWith("http") ? path : this.base + path, {
        method,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new GitHubError(0, e.message);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const limited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
      throw new GitHubError(limited ? 429 : res.status, data?.message);
    }
    return data;
  }

  async repoInfo() {
    const info = await this.api("");
    if (!this.branch) this.branch = info.default_branch || "main";
    return info;
  }

  async headSha() {
    try {
      const ref = await this.api(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
      return ref.object.sha;
    } catch (e) {
      if (e.status === 409 || e.status === 404) return null; // empty repository or no such branch yet
      throw e;
    }
  }

  // An empty repository has no commit to build on; the contents API can make the first one.
  async bootstrap() {
    const readme = "# Penmit PDF notes\n\nPDFs and handwriting synced by [Penmit PDF](https://github.com/AI-Inspact-Lab/penmit-pdf).\nEach folder under `penmit/` is one PDF: `document.pdf`, `meta.json` and `ink.json`.\n";
    const body = { message: "Start Penmit PDF notes", content: await bytesToBase64(enc.encode(readme)) };
    try {
      await this.api(`/contents/README.md`, { method: "PUT", body: { ...body, branch: this.branch } });
    } catch (e) {
      if (e.status !== 404 && e.status !== 422) throw e;
      await this.api(`/contents/README.md`, { method: "PUT", body });
      this.branch = (await this.api("")).default_branch || this.branch;
    }
  }

  get key() { return `${this.owner}/${this.repo}`.toLowerCase(); }

  async tree(commitSha) {
    const commit = await this.api(`/git/commits/${commitSha}`);
    const tree = await this.api(`/git/trees/${commit.tree.sha}?recursive=1`);
    const files = new Map();
    for (const e of tree.tree) if (e.type === "blob") files.set(e.path, e.sha);
    return { treeSha: commit.tree.sha, files, truncated: tree.truncated };
  }

  async getBlob(sha) {
    const b = await this.api(`/git/blobs/${sha}`);
    return base64ToBytes(b.content);
  }

  async putBlob(bytes) {
    const b = await this.api(`/git/blobs`, { method: "POST", body: { content: await bytesToBase64(bytes), encoding: "base64" } });
    return b.sha;
  }

  async commit(parent, baseTree, entries, message) {
    const tree = await this.api(`/git/trees`, { method: "POST", body: { base_tree: baseTree, tree: entries } });
    const commit = await this.api(`/git/commits`, { method: "POST", body: { message, tree: tree.sha, parents: [parent] } });
    await this.api(`/git/refs/heads/${encodeURIComponent(this.branch)}`, { method: "PATCH", body: { sha: commit.sha, force: false } });
    return commit.sha;
  }
}

const path = (id, name) => `${ROOT}/${id}/${name}`;

function remoteDocs(files) {
  const docs = new Map();
  for (const [p, sha] of files) {
    const m = /^penmit\/([0-9a-f]{64})\/(document\.pdf|meta\.json|ink\.json)$/.exec(p);
    if (!m) continue;
    if (!docs.has(m[1])) docs.set(m[1], {});
    docs.get(m[1])[m[2].split(".")[0]] = sha;
  }
  return docs;
}

// store: { listDocs, getDoc, getFile, getInk, putDoc, putFile, putInk(ink, changedByMerge), removeDoc, onDocDownloaded }
export async function sync(gh, store, { onProgress = () => {} } = {}) {
  await gh.repoInfo();
  let head = await gh.headSha();
  if (!head) { await gh.bootstrap(); head = await gh.headSha(); }

  for (let attempt = 0; ; attempt++) {
    onProgress("scan");
    const { treeSha, files, truncated } = await gh.tree(head);
    if (truncated) console.warn("GitHub tree listing was truncated");
    const remote = remoteDocs(files);
    const local = await store.listDocs();
    const localIds = new Set(local.map((d) => d.id));
    const entries = [];
    const after = [];
    const stats = { up: 0, down: 0, merged: 0, removed: 0 };

    for (const d0 of local) {
      // Sync records only count for the repository they were made with; after switching
      // repositories everything is treated as new rather than as deleted.
      const d = d0.synced?.repo === gh.key ? d0 : { ...d0, synced: null };
      const r = remote.get(d.id);
      if (d.deleted) {
        if (r) for (const name of ["document.pdf", "meta.json", "ink.json"]) {
          if (files.has(path(d.id, name))) entries.push({ path: path(d.id, name), mode: "100644", type: "blob", sha: null });
        }
        after.push(() => store.removeDoc(d.id));
        stats.removed++;
        continue;
      }
      if (!r?.document && d.synced) {
        // Synced before and gone from GitHub now: another device deleted it.
        after.push(() => store.removeDoc(d.id));
        stats.removed++;
        continue;
      }

      onProgress("doc", d.name);
      const synced = { ...(d.synced || {}), repo: gh.key };
      if (!r?.document) {
        const file = await store.getFile(d.id);
        if (file.byteLength > MAX_BLOB) throw Object.assign(new GitHubError(413, d.name), { tooLarge: d.name });
        const sha = await gh.putBlob(file);
        entries.push({ path: path(d.id, "document.pdf"), mode: "100644", type: "blob", sha });
        synced.document = sha;
        stats.up++;
      } else {
        synced.document = r.document;
      }

      // Handwriting: merge when GitHub has changes this device hasn't seen.
      const localInk = await store.getInk(d.id);
      let merged = localInk;
      if (r?.ink && r.ink !== d.synced?.ink) {
        const remoteInk = inkFromBytes(d.id, await gh.getBlob(r.ink));
        merged = mergeInk(localInk, remoteInk);
        if (!sameInk(merged, localInk)) stats.merged++;
      }
      const inkBytes = inkToBytes(merged);
      const inkSha = await gitBlobSha(inkBytes);
      if (inkSha !== r?.ink) {
        entries.push({ path: path(d.id, "ink.json"), mode: "100644", type: "blob", sha: await gh.putBlob(inkBytes) });
        if (r?.ink) stats.up++;
      }
      synced.ink = inkSha;

      // Metadata: the newer rename wins.
      let meta = { id: d.id, name: d.name, pageCount: d.pageCount, size: d.size, addedAt: d.addedAt, updatedAt: d.updatedAt };
      if (r?.meta && r.meta !== d.synced?.meta) {
        const remoteMeta = JSON.parse(dec.decode(await gh.getBlob(r.meta)));
        if ((remoteMeta.updatedAt || 0) > (d.updatedAt || 0)) meta = { ...meta, name: remoteMeta.name, updatedAt: remoteMeta.updatedAt };
      }
      const metaBytes = enc.encode(JSON.stringify(meta, null, 2));
      const metaSha = await gitBlobSha(metaBytes);
      if (metaSha !== r?.meta) entries.push({ path: path(d.id, "meta.json"), mode: "100644", type: "blob", sha: await gh.putBlob(metaBytes) });
      synced.meta = metaSha;

      after.push(async () => {
        // Strokes drawn while syncing are kept: merge once more with what is stored now.
        const now = await store.getInk(d.id);
        const final = mergeInk(now, merged);
        await store.putInk(final, !sameInk(final, now));
        const current = (await store.getDoc(d.id)) || d;
        await store.putDoc({ ...current, name: meta.name, updatedAt: meta.updatedAt, synced });
      });
    }

    // On GitHub but not on this device: download.
    for (const [id, r] of remote) {
      if (localIds.has(id) || !r.document) continue;
      onProgress("download", id);
      const meta = r.meta ? JSON.parse(dec.decode(await gh.getBlob(r.meta))) : { id, name: `${id.slice(0, 8)}.pdf` };
      const pdf = await gh.getBlob(r.document);
      const ink = r.ink ? inkFromBytes(id, await gh.getBlob(r.ink)) : { id, strokes: {}, deleted: {} };
      const metaSha = r.meta || null;
      after.push(async () => {
        await store.putFile(id, pdf);
        await store.putInk(ink, false);
        await store.putDoc({
          id, name: meta.name, size: pdf.byteLength, pageCount: meta.pageCount || 0,
          addedAt: meta.addedAt || Date.now(), updatedAt: meta.updatedAt || Date.now(),
          synced: { repo: gh.key, document: r.document, ink: r.ink || null, meta: metaSha },
        });
        await store.onDocDownloaded?.(id);
      });
      stats.down++;
    }

    if (entries.length) {
      onProgress("commit");
      const device = navigator.userAgentData?.platform || navigator.platform || "device";
      try {
        await gh.commit(head, treeSha, entries, `Sync from Penmit PDF (${device})`);
      } catch (e) {
        // Someone else pushed in the meantime: start over from their commit.
        if (e.status === 422 && attempt < 2) { head = await gh.headSha(); continue; }
        throw e;
      }
    }
    for (const fn of after) await fn();
    return stats;
  }
}
