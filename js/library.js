(function () {
'use strict';
// Library storage in IndexedDB.
//   pieces:  metadata records { id, title, readerId, size, pageCount, lastPage, added, thumb, folderId, order }
//   files:   the original uploaded blobs, keyed by piece id
//   folders: { id, name, added }  (one level deep; a piece is in a folder or at the top level)
// Within a folder, `order` gives the play order (0,1,2,...). Everything stays in this browser.

const DB_NAME = 'music-book';
const DB_VERSION = 4;

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
        if (!d.objectStoreNames.contains('annotations')) d.createObjectStore('annotations');   // markings per stored file
        if (!d.objectStoreNames.contains('layouts')) d.createObjectStore('layouts');   // analysed page layout per stored file
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
    t.onerror = e => reject(e?.target?.error || t.error || new Error('database request failed'));
    t.onabort = () => reject(t.error || new Error('database transaction aborted'));
  }));
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });

// Sync support: every piece/folder record carries `u`, the time it was last changed here, and permanent deletes leave a
// tombstone (so another device can tell "deleted" from "never had it"). Listeners hear about every change.
const listeners = [];
const onChange = fn => { listeners.push(fn); };
const notify = kind => { for (const f of listeners) { try { f(kind); } catch (e) { console.warn(e); } } };
async function tomb(t, kind, id) {                        // (t must include the 'layouts' store)
  const ls = t.objectStore('layouts');
  const tombs = (await req(ls.get('meta:tombs'))) || { p: {}, f: {} };
  tombs[kind][id] = Date.now();
  ls.put(tombs, 'meta:tombs');
}

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

async function getLayout(fileId) {
  return tx(['layouts'], 'readonly', t => req(t.objectStore('layouts').get(fileId)));
}
// Small settings records (folder order, what is open) live in the `layouts` store under 'meta:<name>' keys: tiny values, no blobs.
async function getMeta(name) {
  return tx(['layouts'], 'readonly', t => req(t.objectStore('layouts').get('meta:' + name)));
}
async function putMeta(name, value) {
  return tx(['layouts'], 'readwrite', t => { t.objectStore('layouts').put(value, 'meta:' + name); });
}
async function deleteMeta(name) {
  return tx(['layouts'], 'readwrite', t => { t.objectStore('layouts').delete('meta:' + name); });
}
async function getAnnotations(fileId) {
  return tx(['annotations'], 'readonly', t => req(t.objectStore('annotations').get(fileId)));
}
async function putAnnotations(fileId, data) {
  return tx(['annotations'], 'readwrite', t => { t.objectStore('annotations').put({ ...data, u: Date.now() }, fileId); });
}
async function putLayout(fileId, layout) {
  return tx(['layouts'], 'readwrite', t => { t.objectStore('layouts').put(layout, fileId); });
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
      added: Date.now(), u: Date.now(),
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
    const next = { ...cur, ...patch, u: Date.now() };
    store.put(next);
    return next;
  });
}

// Removing a piece removes one placement. The stored file is deleted only when no other
// placement still points at it (like a hard link: the data lives until its last name is gone).
async function deletePiece(id) {
  return tx(['pieces', 'files', 'layouts', 'annotations'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    const me = all.find(p => p.id === id);
    if (!me) return;
    store.delete(id);
    await tomb(t, 'p', id);
    const fid = me.fileId || me.id;
    if (!all.some(p => p.id !== id && (p.fileId || p.id) === fid)) { t.objectStore('files').delete(fid); t.objectStore('layouts').delete(fid); t.objectStore('annotations').delete(fid); }
  });
}

// "Copy": a new placement of the same score in another folder. No bytes are duplicated;
// the new record shares the source's stored file (title, last page and order are its own;
// pass `title` to name this placement differently from the source).
async function addLink(sourceId, folderId, title) {
  return tx(['pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    const src = all.find(p => p.id === sourceId);
    if (!src) return null;
    const id = crypto.randomUUID();
    const piece = { ...src, id, fileId: src.fileId || src.id, folderId, order: nextOrder(all, folderId), lastPage: 1, added: Date.now(), u: Date.now() };
    if (title) piece.title = title;
    store.put(piece);
    return piece;
  });
}

// ---- trash ----
// "Trashing" keeps the record (and its stored file) but flags it; the app hides flagged pieces
// from the library. deletePiece() is the permanent delete.
async function trashPiece(id) {
  return tx(['pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const cur = await req(store.get(id));
    if (!cur) return null;
    const next = { ...cur, trashedAt: Date.now(), trashedFrom: cur.folderId ?? null, trashedWithFolder: false, folderId: null, u: Date.now() };
    store.put(next);
    return next;
  });
}

// Take a piece out of the trash into a folder (null = top level), at the end of that folder's order.
async function restorePiece(id, folderId) {
  return tx(['pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    const cur = all.find(p => p.id === id);
    if (!cur) return null;
    const next = { ...cur, trashedAt: null, trashedFrom: null, trashedWithFolder: false, folderId, order: nextOrder(all.filter(p => p.id !== id && !p.trashedAt), folderId), u: Date.now() };
    store.put(next);
    return next;
  });
}

// Trashing a folder takes its pieces with it: they keep their folderId (and order) and are flagged
// trashedWithFolder, so putting the folder back restores everything exactly as it was.
async function trashFolder(id) {
  return tx(['folders', 'pieces'], 'readwrite', async t => {
    const fs = t.objectStore('folders');
    const ps = t.objectStore('pieces');
    const f = await req(fs.get(id));
    if (!f) return null;
    const now = Date.now();
    fs.put({ ...f, trashedAt: now, u: now });
    const all = await req(ps.getAll());
    for (const p of all) {
      if (p.folderId === id && !p.trashedAt) ps.put({ ...p, trashedAt: now, trashedFrom: id, trashedWithFolder: true, u: now });
    }
    return f;
  });
}

async function restoreFolder(id) {
  return tx(['folders', 'pieces'], 'readwrite', async t => {
    const fs = t.objectStore('folders');
    const ps = t.objectStore('pieces');
    const f = await req(fs.get(id));
    if (!f) return null;
    fs.put({ ...f, trashedAt: null, u: Date.now() });
    const all = await req(ps.getAll());
    for (const p of all) {
      if (p.folderId === id && p.trashedWithFolder) ps.put({ ...p, trashedAt: null, trashedFrom: null, trashedWithFolder: false, u: Date.now() });
    }
    return f;
  });
}

// Permanently delete a trashed folder and the pieces that went into the trash with it.
async function deleteFolderForever(id) {
  return tx(['folders', 'pieces', 'files', 'layouts', 'annotations'], 'readwrite', async t => {
    const ps = t.objectStore('pieces');
    const all = await req(ps.getAll());
    const victims = all.filter(p => p.folderId === id && p.trashedWithFolder);
    const gone = new Set(victims.map(p => p.id));
    for (const p of victims) { ps.delete(p.id); await tomb(t, 'p', p.id); }
    await tomb(t, 'f', id);
    const remaining = all.filter(p => !gone.has(p.id));
    for (const fid of new Set(victims.map(p => p.fileId || p.id))) {
      if (!remaining.some(p => (p.fileId || p.id) === fid)) { t.objectStore('files').delete(fid); t.objectStore('layouts').delete(fid); t.objectStore('annotations').delete(fid); }
    }
    t.objectStore('folders').delete(id);
  });
}

// Move a piece into a folder (or to the top level with null); it goes to the end of that folder's order.
async function setPieceFolder(id, folderId) {
  return tx(['pieces'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    const cur = all.find(p => p.id === id);
    if (!cur) return null;
    const next = { ...cur, folderId, order: nextOrder(all.filter(p => p.id !== id), folderId), u: Date.now() };
    store.put(next);
    return next;
  });
}

// orderedIds: ids of a folder's pieces in the new order.
// Play order of a folder: a list of piece ids kept in one small record (rewriting the pieces themselves, with their
// thumbnail blobs, was failing in some browsers). folderId = null is the top level.
async function loadOrders() { return (await getMeta('orders')) || {}; }
async function loadOrderTimes() { return (await getMeta('orderst')) || {}; }
async function reorderPieces(folderId, orderedIds) {
  const all = await loadOrders(), times = await loadOrderTimes();
  all[folderId ?? ''] = orderedIds;
  times[folderId ?? ''] = Date.now();
  await putMeta('orders', all);
  await putMeta('orderst', times);
}

// ---- folders ----

async function listFolders() {
  const all = await tx(['folders'], 'readonly', t => req(t.objectStore('folders').getAll()));
  return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

async function addFolder(name) {
  const folder = { id: crypto.randomUUID(), name, added: Date.now(), u: Date.now() };
  await tx(['folders'], 'readwrite', t => { t.objectStore('folders').put(folder); });
  return folder;
}

async function updateFolder(id, patch) {
  return tx(['folders'], 'readwrite', async t => {
    const store = t.objectStore('folders');
    const cur = await req(store.get(id));
    if (!cur) return null;
    const next = { ...cur, ...patch, u: Date.now() };
    store.put(next);
    return next;
  });
}

// Deleting a folder never deletes music: its pieces move to the top level.
async function deleteFolder(id) {
  return tx(['folders', 'pieces', 'layouts'], 'readwrite', async t => {
    const store = t.objectStore('pieces');
    const all = await req(store.getAll());
    for (const p of all) if (p.folderId === id) store.put({ ...p, folderId: null, u: Date.now() });
    t.objectStore('folders').delete(id);
    await tomb(t, 'f', id);
  });
}

// ---- sync support (used only by js/sync.js) ----
async function syncSnapshot() {
  return tx(['pieces', 'folders', 'files', 'annotations', 'layouts'], 'readonly', async t => {
    const pieces = await req(t.objectStore('pieces').getAll());
    for (const p of pieces) { if (p.folderId === undefined) p.folderId = null; if (!p.fileId) p.fileId = p.id; }
    const folders = await req(t.objectStore('folders').getAll());
    const fileIds = await req(t.objectStore('files').getAllKeys());
    const ak = await req(t.objectStore('annotations').getAllKeys()), av = await req(t.objectStore('annotations').getAll());
    const annotations = {}; ak.forEach((k, i) => { annotations[k] = av[i]; });
    const ls = t.objectStore('layouts');
    const meta = async n => (await req(ls.get('meta:' + n))) || null;
    return { pieces, folders, fileIds, annotations, orders: (await meta('orders')) || {}, orderTimes: (await meta('orderst')) || {}, tombs: (await meta('tombs')) || { p: {}, f: {} } };
  });
}

// Apply a merge result in one transaction. A record changed here while the sync was running (its `u` no longer matches what the
// sync saw) is left alone; the next sync merges it.
async function syncCommit(plan) {
  const { seen } = plan;
  return tx(['pieces', 'folders', 'files', 'layouts', 'annotations'], 'readwrite', async t => {
    const ps = t.objectStore('pieces'), fs = t.objectStore('folders'), as = t.objectStore('annotations'), ls = t.objectStore('layouts');
    const applied = { pieces: [], folders: [], annotations: [] };
    const goneFiles = new Set();
    for (const p of plan.putPieces || []) {
      const cur = await req(ps.get(p.id));
      if ((cur ? cur.u || 0 : 0) !== (seen.pieces[p.id] || 0)) continue;
      ps.put({ ...p, thumb: cur ? cur.thumb ?? null : null }); applied.pieces.push(p.id);
    }
    for (const id of plan.delPieceIds || []) {
      const cur = await req(ps.get(id));
      if (!cur || (cur.u || 0) !== (seen.pieces[id] || 0)) continue;
      ps.delete(id); goneFiles.add(cur.fileId || cur.id); applied.pieces.push(id);
    }
    for (const f of plan.putFolders || []) {
      const cur = await req(fs.get(f.id));
      if ((cur ? cur.u || 0 : 0) !== (seen.folders[f.id] || 0)) continue;
      fs.put(f); applied.folders.push(f.id);
    }
    for (const id of plan.delFolderIds || []) {
      const cur = await req(fs.get(id));
      if (!cur || (cur.u || 0) !== (seen.folders[id] || 0)) continue;
      fs.delete(id); applied.folders.push(id);
    }
    for (const [fid, rec] of Object.entries(plan.putAnnotations || {})) {
      const cur = await req(as.get(fid));
      if ((cur ? cur.u || 0 : 0) !== (seen.ann[fid] || 0)) continue;
      as.put(rec, fid); applied.annotations.push(fid);
    }
    if (goneFiles.size) {                                        // a stored file goes when its last placement does
      const remaining = await req(ps.getAll());
      for (const fid of goneFiles) if (!remaining.some(p => (p.fileId || p.id) === fid)) { t.objectStore('files').delete(fid); ls.delete(fid); as.delete(fid); }
    }
    if (plan.orders) { ls.put(plan.orders, 'meta:orders'); ls.put(plan.orderTimes, 'meta:orderst'); }
    if (plan.tombs) ls.put(plan.tombs, 'meta:tombs');
    return applied;
  });
}
async function putFileBlob(fileId, blob) { return tx(['files'], 'readwrite', t => { t.objectStore('files').put(blob, fileId); }); }
async function setPieceThumb(id, thumb) {                         // (no change stamp: a thumbnail is local, never synced)
  return tx(['pieces'], 'readwrite', async t => { const s = t.objectStore('pieces'), cur = await req(s.get(id)); if (cur) s.put({ ...cur, thumb }); });
}

async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}

Object.assign(MB, {
  listPieces, getPiece, getFile, getLayout, putLayout, getAnnotations, putAnnotations, addPiece, addLink, updatePiece, deletePiece, trashPiece, restorePiece, trashFolder, restoreFolder, deleteFolderForever, setPieceFolder, reorderPieces, loadOrders, getMeta, putMeta, deleteMeta, onChange, syncSnapshot, syncCommit, putFileBlob, setPieceThumb,
  listFolders, addFolder, updateFolder, deleteFolder, requestPersistence,
});
// every change to the library or the markings is announced (sync listens)
for (const k of ['addPiece', 'updatePiece', 'deletePiece', 'addLink', 'trashPiece', 'restorePiece', 'trashFolder', 'restoreFolder', 'deleteFolderForever', 'setPieceFolder',
                 'reorderPieces', 'addFolder', 'updateFolder', 'deleteFolder', 'putAnnotations']) {
  const f = MB[k];
  MB[k] = async (...a) => { const r = await f(...a); notify(k); return r; };
}
})();
