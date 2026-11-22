(function () {
'use strict';
// Library storage in IndexedDB.
//   pieces:  metadata records { id, title, readerId, size, pageCount, lastPage, added, thumb, folderId, order }
//   files:   the original uploaded blobs, keyed by piece id
//   folders: { id, name, added }  (one level deep; a piece is in a folder or at the top level)
// Within a folder, `order` gives the play order (0,1,2,...). Everything stays in this browser.

const DB_NAME = 'music-book';
const DB_VERSION = 2;

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('pieces')) d.createObjectStore('pieces', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('folders')) d.createObjectStore('folders', { keyPath: 'id' });
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

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });

// ---- pieces ----

async function listPieces() {
  const all = await tx(['pieces'], 'readonly', t => req(t.objectStore('pieces').getAll()));
  for (const p of all) {
    if (p.folderId === undefined) p.folderId = null;
    if (!p.fileId) p.fileId = p.id;          // key of the stored file; several pieces can share one
  }
  return all.sort(byTitle);
}

async function getPiece(id) {
  return tx(['pieces'], 'readonly', t => req(t.objectStore('pieces').get(id)));
}

async function getFile(id) {
  return tx(['files'], 'readonly', t => req(t.objectStore('files').get(id)));
}

function nextOrder(all, folderId) {
  let max = -1;
  for (const p of all) if ((p.folderId ?? null) === folderId && typeof p.order === 'number') max = Math.max(max, p.order);
  return max + 1;
}

async function addPiece({ title, readerId, blob, pageCount, thumb, folderId = null, hash = null }) {
  const id = crypto.randomUUID();
  return tx(['pieces', 'files'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    const piece = {
      id, title, readerId,
      size: blob.size,
      pageCount,
      lastPage: 1,
      added: Date.now(),
      thumb: thumb || null,
      fileId: id,                // placements made with addLink() point at the same stored file
      hash,                      // SHA-256 of the file bytes (hex), used to spot duplicates
      folderId,
      order: nextOrder(all, folderId),
    };
    store.put(piece);
    t.objectStore('files').put(blob, id);
    return piece;
  });
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

// Removing a piece removes one placement. The stored file is deleted only when no other
// placement still points at it (like a hard link: the data lives until its last name is gone).
async function deletePiece(id) {
  return tx(['pieces', 'files'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    const me = all.find(p => p.id === id);
    if (!me) return;
    store.delete(id);
    const fid = me.fileId || me.id;
    if (!all.some(p => p.id !== id && (p.fileId || p.id) === fid)) t.objectStore('files').delete(fid);
  });
}

// "Copy": a new placement of the same score in another folder. No bytes are duplicated;
// the new record shares the source's stored file (title, last page and order are its own).
async function addLink(sourceId, folderId) {
  return tx(['pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    const src = all.find(p => p.id === sourceId);
    if (!src) return null;
    const id = crypto.randomUUID();
    const piece = { ...src, id, fileId: src.fileId || src.id, folderId, order: nextOrder(all, folderId), lastPage: 1, added: Date.now() };
    store.put(piece);
    return piece;
  });
}

// Move a piece into a folder (or to the top level with null); it goes to the end of that folder's order.
async function setPieceFolder(id, folderId) {
  return tx(['pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    const cur = all.find(p => p.id === id);
    if (!cur) return null;
    const next = { ...cur, folderId, order: nextOrder(all.filter(p => p.id !== id), folderId) };
    store.put(next);
    return next;
  });
}

// orderedIds: ids of a folder's pieces in the new order.
async function reorderPieces(orderedIds) {
  return tx(['pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    for (const [i, id] of orderedIds.entries()) {
      const cur = await req(store.get(id));
      if (cur) store.put({ ...cur, order: i });
    }
  });
}

// ---- folders ----

async function listFolders() {
  const all = await tx(['folders'], 'readonly', t => req(t.objectStore('folders').getAll()));
  return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

async function addFolder(name) {
  const folder = { id: crypto.randomUUID(), name, added: Date.now() };
  await tx(['folders'], 'readwrite', t => { t.objectStore('folders').put(folder); });
  return folder;
}

async function updateFolder(id, patch) {
  return tx(['folders'], 'readwrite', async t => {
    const store = t.objectStore('folders');
    const cur = await req(store.get(id));
    if (!cur) return null;
    const next = { ...cur, ...patch };
    store.put(next);
    return next;
  });
}

// Deleting a folder never deletes music: its pieces move to the top level.
async function deleteFolder(id) {
  return tx(['folders', 'pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    for (const p of all) if (p.folderId === id) store.put({ ...p, folderId: null });
    t.objectStore('folders').delete(id);
  });
}

async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}

Object.assign(MB, {
  listPieces, getPiece, getFile, addPiece, addLink, updatePiece, deletePiece, setPieceFolder, reorderPieces,
  listFolders, addFolder, updateFolder, deleteFolder, requestPersistence,
});
})();
