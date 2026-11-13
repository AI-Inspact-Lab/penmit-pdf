// GitHub storage: the user's own repository, through the REST API, straight from the device.
// Each sync is one commit made with the Git Data API (blobs, tree, commit, ref), which handles
// files up to 100 MB and changes many files atomically. Layout: penmit/<docId>/<file>.
import { StorageError, FILES, bytesToBase64, base64ToBytes, gitBlobSha } from "./sync.js";

const API = "https://api.github.com";
const ROOT = "penmit";
const enc = new TextEncoder();

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    this.owner = (owner || "").trim();
    this.repo = (repo || "").trim();
    this.branch = (branch || "").trim();
    this.token = (token || "").trim();
  }

  get base() { return `${API}/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}`; }
  get key() { return `${this.owner}/${this.repo}`.toLowerCase(); }

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
      throw new StorageError(0, e.message);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const limited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
      throw new StorageError(limited ? 429 : res.status, data?.message);
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
    const readme = "# Penmit PDF notes\n\nPDFs and handwriting synced by [Penmit PDF](https://github.com/Choo-AI-Dev/penmit-pdf).\nEach folder under `penmit/` is one PDF: `document.pdf`, `meta.json` and `ink.json`.\n";
    const body = { message: "Start Penmit PDF notes", content: await bytesToBase64(enc.encode(readme)) };
    try {
      await this.api(`/contents/README.md`, { method: "PUT", body: { ...body, branch: this.branch } });
    } catch (e) {
      if (e.status !== 404 && e.status !== 422) throw e;
      await this.api(`/contents/README.md`, { method: "PUT", body });
      this.branch = (await this.api("")).default_branch || this.branch;
    }
  }

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

export class GitHubBackend {
  constructor(settings) {
    this.gh = new GitHub(settings);
    this.key = this.gh.key;
  }

  async begin() {
    await this.gh.repoInfo();
    this.head = await this.gh.headSha();
    if (!this.head) { await this.gh.bootstrap(); this.head = await this.gh.headSha(); }
    const { treeSha, files, truncated } = await this.gh.tree(this.head);
    if (truncated) console.warn("GitHub tree listing was truncated");
    this.treeSha = treeSha;
    this.files = files;
    this.entries = [];
    const docs = new Map();
    for (const [p, sha] of files) {
      const m = /^penmit\/([0-9a-f]{64})\/(document\.pdf|meta\.json|ink\.json)$/.exec(p);
      if (!m) continue;
      if (!docs.has(m[1])) docs.set(m[1], {});
      docs.get(m[1])[m[2].split(".")[0]] = sha;
    }
    return { docs };
  }

  read(id, name) { return this.gh.getBlob(this.files.get(path(id, name))); }

  async write(id, name, bytes) {
    const sha = await this.gh.putBlob(bytes);
    this.entries.push({ path: path(id, name), mode: "100644", type: "blob", sha });
    return sha;
  }

  async remove(id) {
    for (const name of FILES) {
      if (this.files.has(path(id, name))) this.entries.push({ path: path(id, name), mode: "100644", type: "blob", sha: null });
    }
  }

  async finish(message) {
    if (!this.entries.length) return;
    try {
      await this.gh.commit(this.head, this.treeSha, this.entries, message);
    } catch (e) {
      if (e.status === 422) throw Object.assign(e, { retry: true }); // not a fast-forward
      throw e;
    }
  }

  version(bytes) { return gitBlobSha(bytes); }
}
