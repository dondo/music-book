(function () {
'use strict';
// Library storage in IndexedDB.
//   pieces: metadata records (small, listed on the library screen)
//   files:  the original uploaded blobs, keyed by the same id
// Everything stays on this device/browser. (Cross-device sync is a later step.)

const DB_NAME = 'music-book';
const DB_VERSION = 1;

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('pieces')) d.createObjectStore('pieces', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(stores, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then(r => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function listPieces() {
  const all = await tx(['pieces'], 'readonly', t => req(t.objectStore('pieces').getAll()));
  return all.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }));
}

async function getPiece(id) {
  return tx(['pieces'], 'readonly', t => req(t.objectStore('pieces').get(id)));
}

async function getFile(id) {
  return tx(['files'], 'readonly', t => req(t.objectStore('files').get(id)));
}

async function addPiece({ title, readerId, blob, pageCount, thumb }) {
  const id = crypto.randomUUID();
  const piece = {
    id, title, readerId,
    size: blob.size,
    pageCount,
    lastPage: 1,
    added: Date.now(),
    thumb: thumb || null,
  };
  await tx(['pieces', 'files'], 'readwrite', t => {
    t.objectStore('pieces').put(piece);
    t.objectStore('files').put(blob, id);
  });
  return piece;
}

async function updatePiece(id, patch) {
  return tx(['pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const cur = await req(store.get(id));
    if (!cur) return null;
    const next = { ...cur, ...patch };
    store.put(next);
    return next;
  });
}

async function deletePiece(id) {
  return tx(['pieces', 'files'], 'readwrite', t => {
    t.objectStore('pieces').delete(id);
    t.objectStore('files').delete(id);
  });
}

async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
MB.listPieces = listPieces;
MB.getPiece = getPiece;
MB.getFile = getFile;
MB.addPiece = addPiece;
MB.updatePiece = updatePiece;
MB.deletePiece = deletePiece;
MB.requestPersistence = requestPersistence;
})();
