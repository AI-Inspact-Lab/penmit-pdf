// Sync between this device and a storage backend (GitHub or Google Drive).
//
// Every PDF is three files in the backend, under its SHA-256 as the folder name:
//   document.pdf   the original PDF (uploaded once)
//   meta.json      name, page count, dates
//   ink.json       the handwriting (small text that merges cleanly)
//
// A backend implements:
//   key                       stable id of the storage location (e.g. "owner/repo", "gdrive:me@x")
//   begin()                   -> { docs: Map(docId -> { document?, meta?, ink? }) } with version tokens
//   read(docId, name)         -> Uint8Array
//   write(docId, name, bytes) -> version token (GitHub stages it; Drive uploads it)
//   remove(docId)             delete the document's folder
//   finish(message)           GitHub commits; throws { retry: true } if someone pushed first
//   version(bytes)            the token the backend would report for these bytes

const enc = new TextEncoder();
const dec = new TextDecoder();
export const FILES = ["document.pdf", "meta.json", "ink.json"];
export const MAX_FILE = 100 * 1024 * 1024;

export class StorageError extends Error {
  constructor(status, message, extra = {}) {
    super(message || `HTTP ${status}`);
    this.status = status;
    Object.assign(this, extra);
  }
}

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

// Git's id for a file's contents; used as the version token by both backends.
export async function gitBlobSha(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const header = enc.encode(`blob ${view.byteLength}\0`);
  const buf = new Uint8Array(header.length + view.byteLength);
  buf.set(header, 0);
  buf.set(view, header.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// Stable JSON, so the same ink always produces the same bytes (and the same version token).
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
  const ka = Object.keys(a.strokes);
  const kb = Object.keys(b.strokes);
  const da = Object.keys(a.deleted);
  const dbk = Object.keys(b.deleted);
  return ka.length === kb.length && da.length === dbk.length && ka.every((k) => k in b.strokes) && da.every((k) => k in b.deleted);
}

// store: { listDocs, getDoc, getFile, getInk, putDoc, putFile, putInk, removeDoc, onDocDownloaded }
export async function sync(backend, store, { onProgress = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    onProgress("scan");
    const { docs: remote } = await backend.begin();
    const key = backend.key;
    const local = await store.listDocs();
    const localIds = new Set(local.map((d) => d.id));
    const after = [];
    const stats = { up: 0, down: 0, merged: 0, removed: 0 };

    for (const d0 of local) {
      // Sync records only count for the place they were made with; after switching storage
      // everything is treated as new rather than as deleted.
      const d = d0.synced?.repo === key ? d0 : { ...d0, synced: null };
      const r = remote.get(d.id);
      if (d.deleted) {
        if (r) await backend.remove(d.id);
        after.push(() => store.removeDoc(d.id));
        stats.removed++;
        continue;
      }
      if (!r?.document && d.synced) {
        // Synced here before and gone now: another device deleted it.
        after.push(() => store.removeDoc(d.id));
        stats.removed++;
        continue;
      }

      onProgress("doc", d.name);
      const synced = { ...(d.synced || {}), repo: key };
      if (!r?.document) {
        const file = await store.getFile(d.id);
        if (file.byteLength > MAX_FILE) throw new StorageError(413, d.name, { tooLarge: d.name });
        synced.document = await backend.write(d.id, "document.pdf", new Uint8Array(file));
        stats.up++;
      } else {
        synced.document = r.document;
      }

      // Handwriting: merge when the backend has changes this device hasn't seen.
      const localInk = await store.getInk(d.id);
      let merged = localInk;
      if (r?.ink && r.ink !== d.synced?.ink) {
        const remoteInk = inkFromBytes(d.id, await backend.read(d.id, "ink.json"));
        merged = mergeInk(localInk, remoteInk);
        if (!sameInk(merged, localInk)) stats.merged++;
      }
      const inkBytes = inkToBytes(merged);
      let inkVersion = await backend.version(inkBytes);
      if (inkVersion !== r?.ink) {
        inkVersion = await backend.write(d.id, "ink.json", inkBytes);
        if (r?.ink) stats.up++;
      }
      synced.ink = inkVersion;

      // Metadata: the newer rename wins.
      let meta = { id: d.id, name: d.name, pageCount: d.pageCount, size: d.size, addedAt: d.addedAt, updatedAt: d.updatedAt };
      if (r?.meta && r.meta !== d.synced?.meta) {
        const remoteMeta = JSON.parse(dec.decode(await backend.read(d.id, "meta.json")));
        if ((remoteMeta.updatedAt || 0) > (d.updatedAt || 0)) meta = { ...meta, name: remoteMeta.name, updatedAt: remoteMeta.updatedAt };
      }
      const metaBytes = enc.encode(JSON.stringify(meta, null, 2));
      let metaVersion = await backend.version(metaBytes);
      if (metaVersion !== r?.meta) metaVersion = await backend.write(d.id, "meta.json", metaBytes);
      synced.meta = metaVersion;

      after.push(async () => {
        // Strokes drawn while syncing are kept: merge once more with what is stored now.
        const now = await store.getInk(d.id);
        await store.putInk(mergeInk(now, merged));
        const current = (await store.getDoc(d.id)) || d;
        await store.putDoc({ ...current, name: meta.name, updatedAt: meta.updatedAt, synced });
      });
    }

    // In the backend but not on this device: download.
    for (const [id, r] of remote) {
      if (localIds.has(id) || !r.document) continue;
      onProgress("download", id);
      const meta = r.meta ? JSON.parse(dec.decode(await backend.read(id, "meta.json"))) : { id, name: `${id.slice(0, 8)}.pdf` };
      const pdf = await backend.read(id, "document.pdf");
      const ink = r.ink ? inkFromBytes(id, await backend.read(id, "ink.json")) : { id, strokes: {}, deleted: {} };
      after.push(async () => {
        await store.putFile(id, pdf);
        await store.putInk(ink);
        await store.putDoc({
          id, name: meta.name, size: pdf.byteLength, pageCount: meta.pageCount || 0,
          addedAt: meta.addedAt || Date.now(), updatedAt: meta.updatedAt || Date.now(),
          synced: { repo: key, document: r.document, ink: r.ink || null, meta: r.meta || null },
        });
        await store.onDocDownloaded?.(id);
      });
      stats.down++;
    }

    onProgress("commit");
    const device = navigator.userAgentData?.platform || navigator.platform || "device";
    try {
      await backend.finish(`Sync from Penmit PDF (${device})`);
    } catch (e) {
      if (e.retry && attempt < 2) continue; // someone else saved first: start over from theirs
      throw e;
    }
    for (const fn of after) await fn();
    return stats;
  }
}
