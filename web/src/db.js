// Local storage in IndexedDB.
//   docs:  { id, name, size, pageCount, addedAt, updatedAt, openedAt, thumb, view, synced, deleted }
//   files: { id, bytes }            original PDF bytes, kept apart so listing docs stays light
//   ink:   { id, strokes, deleted } handwriting, see ink.js
const DB_NAME = "penmit";
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ["docs", "files", "ink"]) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  });
}

export const db = {
  get: (store, id) => run(store, "readonly", (s) => s.get(id)),
  getAll: (store) => run(store, "readonly", (s) => s.getAll()),
  put: (store, value) => run(store, "readwrite", (s) => s.put(value)),
  del: (store, id) => run(store, "readwrite", (s) => s.delete(id)),
  async removeDoc(id) {
    await Promise.all(["docs", "files", "ink"].map((s) => db.del(s, id)));
  },
};

// Ask the browser not to evict our data under storage pressure (best effort).
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      await navigator.storage.persist?.();
    }
  } catch { /* not supported */ }
}

export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
