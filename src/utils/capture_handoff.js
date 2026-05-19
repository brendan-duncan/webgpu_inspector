// Hand off a serialized capture from one extension page to another (e.g. the
// DevTools panel iframe to a standalone window opened from "Open in New
// Window"). localStorage's ~5MB cap blows up on captures with mip data, so we
// stash the JSON in IndexedDB, which on Chromium gets a per-origin quota in
// the hundreds of MB to GB range.

const DB_NAME = "webgpu_inspector_handoff";
const DB_VERSION = 1;
const STORE_NAME = "captures";

function _openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

export async function putCaptureHandoff(key, text) {
  const db = await _openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(text, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function takeCaptureHandoff(key) {
  const db = await _openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const value = getReq.result;
        if (value !== undefined) {
          store.delete(key);
        }
        // resolve only once the delete commits with the transaction.
        tx.oncomplete = () => resolve(value ?? null);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
