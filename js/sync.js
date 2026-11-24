(function () {
'use strict';
/* Sync across devices: the library (pieces, folders, their order) and the markings on every score, including the score files
   themselves, encrypted in the browser and kept in a small Cloudflare Worker + KV store (worker/music-book-sync.js).
   Nothing here is a secret: the Worker only ever holds encrypted bytes. A name (4+ characters) and a two-word passphrase are joined and
   stretched (PBKDF2) into three things: the storage ID, a write token (the Worker lets only its holder in) and the AES-GCM key.
   Lose either the name or the passphrase and the data is unrecoverable. This is separate from the Music Theory app's sync: a different
   Worker, a different salt, so the two share no credentials and no data.

   What is stored (all as encrypted objects):
     manifest         { schema, savedAt, pieces, folders, orders, files, ann }   the index: small, rewritten on each change
       pieces/folders/orders:  id -> { u: time of last change, v: the record | null (deleted) }   (newest change wins; v null is a tombstone)
       files: fileId -> { n: chunks, size }      ann: fileId -> { u }
     a.<fileId>.<u>   the markings of one score as of change time u  { v: 1, items: [...], u }   (older versions are deleted once the manifest names the new one)
     f.<fileId>.<n>   chunk n (4 MB) of a score file
   The manifest is written only if nobody else wrote since it was read (X-Rev), otherwise the sync starts over from a fresh read.
   Markings of a score changed on two devices are merged item by item (items carry ids; an item gone from one side since the last sync is
   a deletion), so drawing on two devices never loses work. */

const SCHEMA = 1, ENVELOPE_V = 1;
const DEFAULT_WORKER = 'https://music-book.dondo.workers.dev';
const ITER = 600000, SALT = 'music-book-sync/v1';
const CHUNK = 4 * 1024 * 1024;
const NAME_MIN = 4, NAME_MAX = 40;
const TOMB_KEEP = 60 * 86400000;                       // a deletion is remembered this long
const WORDS = 'able acorn actor adobe agile alder alley almond alpine amaze amber ample anchor angle anvil apex apple apron arbor arch aroma arrow aspen atlas attic aurora autumn axis badge bagel baker balsa bamboo banjo barn basil basin basket beach beacon beam beaver bell bench berry birch birdie bison blade blaze bloom bluff boat bonsai bonus boots brave bravo bread breeze brick bridge brook broom brush bugle bunny butter cabin cable cactus camel cameo candle candy canoe canvas canyon cargo carol carpet castle cedar cello chalk charm cherry chess chime chorus cider cinder circus clam cliff cloak clock cloud clover coast cobalt cobweb cocoa comet cookie copper coral cosmic cotton cover cradle crane crest crisp crown cuddle curry dagger daisy dance dapper dazzle delta denim desert dimple diner dipper dizzy donut dragon dream drift drum dusk eagle earth echo elbow ember engine fable falcon fancy farm fern ferry fiddle field fiesta finch fizz flame flint flora fluff flute forest fossil fresh frost gadget galaxy garden garnet geese gentle giant ginger glade globe glove glow gnome gold goose grain grape gravel grove guitar gummy hammer happy harbor harp hatch haven hazel heron hobby hollow honey hound humble icing igloo indigo island ivory jacket jade jasper jazz jelly jewel jolly juggle jumbo jungle kayak kettle kitten kiwi knit koala ladder lagoon lake lark laurel lemon lilac lily linen llama locket lotus lucky lunar lunch magic mango maple marble marsh meadow mellow melon merry mint mirror mocha moon moss motor muffin mural mystic napkin nectar needle nimble noble north novel nutmeg oasis ocean olive onyx opal orange orbit orchid otter oyster paddle palm panda paper pasta peach pearl pebble pecan penny pepper piano picnic pillow pilot pine pixel planet plum pocket polar pond poppy pretty puddle puzzle quail quartz quest quiet quill quilt rabbit radar radio rain raisin ranch raven reef rhythm ribbon ridge ripple river robin rocket rose ruby rustic saddle sage sailor salmon salsa sand sandal satin shadow shell silk silver sketch slate sleepy smile snow soda solar sonnet spark spice spoon sprout spruce squid star stone storm stream sugar summer sunny swan swift tablet tango teapot tidal tiger timber toast toffee tomato topaz trail tulip tundra turnip turtle umber umpire unity valley velvet violet vivid waffle wagon walnut water wave whale wheat whisk willow winter wizard wolf wonder yarn yellow yodel zebra zephyr zesty zigzag'.split(' ');

// ---- bytes and text ----
const enc = new TextEncoder(), dec = new TextDecoder();
const annName = (fid, u) => 'a.' + fid + '.' + u;
const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
const norm = s => String(s).normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

// ---- credentials ----
const validName = n => { n = norm(n); return n.length >= NAME_MIN && n.length <= NAME_MAX; };
const validPass = p => /^[a-z]{4,6}-[a-z]{4,6}$/.test(norm(p));
function randInt(n) {                                   // uniform in [0, n), no modulo bias
  const lim = Math.floor(4294967296 / n) * n, a = new Uint32Array(1);
  do { crypto.getRandomValues(a); } while (a[0] >= lim);
  return a[0] % n;
}
const randomPassphrase = () => WORDS[randInt(WORDS.length)] + '-' + WORDS[randInt(WORDS.length)];
// name + passphrase -> { id, token, key }: one PBKDF2 run whose output is split into three independent parts
async function derive(name, pass) {
  const km = await crypto.subtle.importKey('raw', enc.encode(norm(name) + '\n' + norm(pass)), 'PBKDF2', false, ['deriveBits']);
  const u = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: ITER }, km, 768));
  const key = await crypto.subtle.importKey('raw', u.slice(64, 96), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id: hex(u.slice(0, 32)), token: hex(u.slice(32, 64)), key };
}

// ---- the envelope: [version][flags: 1 = gzip][12-byte iv][AES-GCM ciphertext] ----
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
async function seal(key, bytes, gzip) {
  const z = !!gzip && typeof CompressionStream !== 'undefined';
  const body = z ? await pipe(bytes, new CompressionStream('gzip')) : bytes;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
  const out = new Uint8Array(14 + ct.length);
  out[0] = ENVELOPE_V; out[1] = z ? 1 : 0; out.set(iv, 2); out.set(ct, 14);
  return out;
}
async function open(key, bytes) {
  const u = new Uint8Array(bytes);
  if (u.length < 15) throw new Error('The stored data is not readable.');
  if (u[0] > ENVELOPE_V) throw Object.assign(new Error('The stored data was written by a newer version of the app. Update the app first.'), { newer: true });
  let body;
  try { body = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(2, 14) }, key, u.slice(14))); }
  catch { throw new Error('Could not decrypt: wrong name or passphrase?'); }
  return u[1] & 1 ? pipe(body, new DecompressionStream('gzip')) : body;
}
const sealJSON = (key, obj) => seal(key, enc.encode(JSON.stringify(obj)), true);
const openJSON = async (key, bytes) => JSON.parse(dec.decode(await open(key, bytes)));

// ---- merging (pure) ----
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
// two records { u, v }: the later change wins; at the same time, the larger JSON (so every device settles on the same one)
function pickNewer(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.u !== b.u) return a.u > b.u ? a : b;
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}
// local and remote maps id -> { u, v } -> { merged, toLocal: [ids], toRemote: [ids] }; old deletions are forgotten
function mergeMaps(local, remote, now) {
  const merged = {}, toLocal = [], toRemote = [];
  for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const a = local[id], b = remote[id], r = pickNewer(a, b);
    if (r.v === null && now - r.u > TOMB_KEEP) { if (b) toRemote.push(id); if (a) toLocal.push(id); continue; }
    merged[id] = r;
    if (!a || !same(a, r)) toLocal.push(id);
    if (!b || !same(b, r)) toRemote.push(id);
  }
  return { merged, toLocal, toRemote };
}
// the markings of one score, three ways: local items, remote items, and the ids both sides had at the last sync
function mergeItems(local, remote, baseIds, localNewer) {
  const L = new Map(local.map(i => [i.id, i])), R = new Map(remote.map(i => [i.id, i])), out = [];
  for (const it of local) {
    if (R.has(it.id)) out.push(localNewer ? it : R.get(it.id));
    else if (!baseIds.has(it.id)) out.push(it);               // added here
  }                                                            // (in the base but gone from the remote: deleted there)
  for (const it of remote) if (!L.has(it.id) && !baseIds.has(it.id)) out.push(it);     // added there
  return out;
}

// ---- projecting library records ----
const pieceV = p => { const v = { ...p }; delete v.thumb; delete v.u; return v; };
const folderV = f => { const v = { ...f }; delete v.u; return v; };
function localRecords(snap) {
  const pieces = {}, folders = {}, orders = {};
  for (const p of snap.pieces) pieces[p.id] = { u: p.u || p.added || 1, v: pieceV(p) };
  for (const [id, t] of Object.entries(snap.tombs.p || {})) if (!pieces[id] || pieces[id].u < t) pieces[id] = { u: t, v: null };
  for (const f of snap.folders) folders[f.id] = { u: f.u || f.added || 1, v: folderV(f) };
  for (const [id, t] of Object.entries(snap.tombs.f || {})) if (!folders[id] || folders[id].u < t) folders[id] = { u: t, v: null };
  for (const [k, ids] of Object.entries(snap.orders)) orders[k] = { u: snap.orderTimes[k] || 0, v: ids };
  return { pieces, folders, orders };
}

// ---- the Worker ----
const workerURL = () => (typeof window !== 'undefined' && window.MB_SYNC_URL) || DEFAULT_WORKER;
async function call(method, d, name, body, headers) {
  let r;
  try { r = await fetch(workerURL() + '/v1/' + d.id + '/' + name, { method, headers: { Authorization: 'Bearer ' + d.token, ...(headers || {}) }, body }); }
  catch { throw new Error('Could not reach the sync service. Check the connection; if you are online, the service may not allow this page’s address (' + (typeof location !== 'undefined' ? location.origin : '?') + ').'); }
  if (r.status === 403) throw new Error('The sync service refused the credentials.');
  return { status: r.status, rev: Number(r.headers.get('X-Rev') || 0), buf: method === 'GET' && r.status === 200 ? new Uint8Array(await r.arrayBuffer()) : null };
}
async function getObject(d, name) {
  const r = await call('GET', d, name);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error('The sync service answered ' + r.status + '.');
  return r;
}
async function putObject(d, name, bytes, headers) {
  const r = await call('PUT', d, name, bytes, headers);
  if (r.status === 413) throw new Error('A file is too large for the sync service.');
  if (r.status !== 200 && r.status !== 409) throw new Error('The sync service answered ' + r.status + '.');
  return r;
}
const exists = async d => { const r = await call('GET', d, 'manifest'); if (r.status === 404) return false; if (r.status === 200) return true; throw new Error('The sync service answered ' + r.status + '.'); };
async function newAccount(name, tries = 20) {                    // a name + a fresh passphrase whose ID is free
  const pass = randomPassphrase(), d = await derive(name, pass);
  if (!(await exists(d))) return { name: norm(name), pass, d };
  if (tries <= 0) throw new Error('Could not find an unused passphrase. Try a different name.');
  return newAccount(name, tries - 1);
}
async function pullManifest(d) {
  const r = await getObject(d, 'manifest');
  if (!r) return { manifest: null, rev: 0 };
  const m = await openJSON(d.key, r.buf);
  if (!m || typeof m.schema !== 'number') throw new Error('The stored data is not readable.');
  if (m.schema > SCHEMA) throw Object.assign(new Error('The stored data was written by a newer version of the app. Update the app first.'), { newer: true });
  return { manifest: m, rev: r.rev };
}

// ---- file chunks ----
async function uploadFile(d, fid, blob, tick) {
  const n = Math.max(1, Math.ceil(blob.size / CHUNK));
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer());
    await putObject(d, 'f.' + fid + '.' + i, await seal(d.key, bytes, false));
    if (tick) tick(i + 1, n);
  }
  return { n, size: blob.size };
}
async function downloadFile(d, fid, info, tick) {
  const parts = [];
  for (let i = 0; i < info.n; i++) {
    const r = await getObject(d, 'f.' + fid + '.' + i);
    if (!r) throw new Error('A score file is missing from the sync store.');
    parts.push(await open(d.key, r.buf));
    if (tick) tick(i + 1, info.n);
  }
  return new Blob(parts);
}

// ---- one sync attempt ----
class Conflict extends Error {}
async function attempt(d, st, say) {
  const now = Date.now();
  const { manifest, rev } = await pullManifest(d);
  const R = { pieces: {}, folders: {}, orders: {}, files: {}, ann: {}, settings: null, ...(manifest || {}) };
  const snap = await MB.syncSnapshot();
  const base = (await MB.getMeta('syncbase')) || { ann: {} };
  const L = localRecords(snap);

  const mp = mergeMaps(L.pieces, R.pieces, now), mf = mergeMaps(L.folders, R.folders, now), mo = mergeMaps(L.orders, R.orders, now);
  // settings: one record (a theme, bindings, ...) where the later change wins
  const ls = MB.settingsSync.get(), LS = ls.u ? { settings: { u: ls.u, v: ls.v } } : {};
  const ms = mergeMaps(LS, R.settings ? { settings: R.settings } : {}, now);
  const live = Object.values(mp.merged).filter(r => r.v);
  const refs = new Set(live.map(r => r.v.fileId || r.v.id));
  const haveLocal = new Set(snap.fileIds);

  // files: upload what the store lacks (and this device has); note what this device lacks
  const files = {};
  for (const fid of refs) if (R.files[fid]) files[fid] = R.files[fid];
  const up = [...refs].filter(fid => !files[fid] && haveLocal.has(fid));
  let i = 0;
  for (const fid of up) {
    i++;
    const blob = await MB.getFile(fid);
    if (!blob) continue;
    files[fid] = await uploadFile(d, fid, blob, (k, n) => say(`Uploading file ${i} of ${up.length}` + (n > 1 ? ` (${k}/${n})` : '') + '…'));
  }

  // markings
  const ann = {}, writeLocal = {}, newBase = { ann: {} }, uploadsAnn = [];
  const seenAnn = {};
  for (const fid of refs) {
    const lr = snap.annotations[fid], lu = lr ? lr.u || 0 : 0, litems = lr ? lr.items || [] : [];
    seenAnn[fid] = lu;
    const rmeta = R.ann[fid], ru = rmeta ? rmeta.u || 0 : 0;
    const b = base.ann[fid] || { u: 0, ids: [] }, baseIds = new Set(b.ids);
    const lch = lu !== b.u, rch = ru !== b.u;
    let items = litems, u = lu, push = false, adopt = false;
    if (!lch && !rch) { if (rmeta) ann[fid] = rmeta; newBase.ann[fid] = b; continue; }
    if (rch) {
      const obj = rmeta ? await getObject(d, annName(fid, ru)) : null;
      const remote = obj ? await openJSON(d.key, obj.buf) : null;
      if (!remote) { if (lch) push = true; }
      else if (!lch) { items = remote.items || []; u = ru; adopt = true; }
      else {
        const merged = mergeItems(litems, remote.items || [], baseIds, lu >= ru);
        if (same(merged, remote.items || [])) { items = merged; u = ru; adopt = true; }
        else { items = merged; u = now; push = true; adopt = true; }
      }
    } else push = true;                                          // only this device changed it
    if (push) uploadsAnn.push({ fid, rec: { v: 1, items, u: u || now } });
    if (push && !u) u = now;
    if (adopt) writeLocal[fid] = { v: 1, items, u };
    ann[fid] = { u };
    newBase.ann[fid] = { u, ids: items.map(it => it.id) };
  }
  for (const { fid, rec } of uploadsAnn) await putObject(d, annName(fid, rec.u), await sealJSON(d.key, rec));

  // the index
  const out = {
    schema: SCHEMA, savedAt: now,
    pieces: mp.merged, folders: mf.merged, orders: mo.merged, files, ann, settings: ms.merged.settings || null,
  };
  const changed = ms.toRemote.length || mp.toRemote.length || mf.toRemote.length || mo.toRemote.length || uploadsAnn.length || up.length ||
    Object.keys(R.files).some(f => !files[f]) || !manifest;
  if (changed) {
    const r = await putObject(d, 'manifest', await sealJSON(d.key, out), { 'X-Rev': String(rev) });
    if (r.status === 409) throw new Conflict('conflict');
  }

  // what the store no longer needs
  for (const [fid, info] of Object.entries(R.files)) {
    if (files[fid]) continue;
    for (let k = 0; k < info.n; k++) { try { await call('DELETE', d, 'f.' + fid + '.' + k); } catch { /* best effort */ } }
    if (R.ann[fid]) { try { await call('DELETE', d, annName(fid, R.ann[fid].u)); } catch { /* best effort */ } }
  }
  for (const { fid, rec } of uploadsAnn) {                          // the version this one replaced
    const old = R.ann[fid];
    if (old && old.u !== rec.u) { try { await call('DELETE', d, annName(fid, old.u)); } catch { /* best effort */ } }
  }

  // bring in what this device lacks
  const need = Object.keys(files).filter(fid => !haveLocal.has(fid));
  let j = 0;
  for (const fid of need) {
    j++;
    await MB.putFileBlob(fid, await downloadFile(d, fid, files[fid], (k, n) => say(`Downloading file ${j} of ${need.length}` + (n > 1 ? ` (${k}/${n})` : '') + '…')));
  }

  // apply the merge here
  const seen = { pieces: {}, folders: {}, ann: seenAnn };
  for (const p of snap.pieces) seen.pieces[p.id] = p.u || 0;
  for (const f of snap.folders) seen.folders[f.id] = f.u || 0;
  const tombs = { p: {}, f: {} };
  for (const [id, r] of Object.entries(mp.merged)) if (r.v === null) tombs.p[id] = r.u;
  for (const [id, r] of Object.entries(mf.merged)) if (r.v === null) tombs.f[id] = r.u;
  const orders = {}, orderTimes = {};
  for (const [k, r] of Object.entries(mo.merged)) { orders[k] = r.v; orderTimes[k] = r.u; }
  const localPiece = new Set(snap.pieces.map(p => p.id)), localFolder = new Set(snap.folders.map(f => f.id));
  const plan = {
    seen, tombs, orders, orderTimes, putAnnotations: writeLocal,
    putPieces: mp.toLocal.filter(id => mp.merged[id] && mp.merged[id].v).map(id => ({ ...mp.merged[id].v, id, u: mp.merged[id].u })),
    delPieceIds: mp.toLocal.filter(id => localPiece.has(id) && !(mp.merged[id] && mp.merged[id].v)),
    putFolders: mf.toLocal.filter(id => mf.merged[id] && mf.merged[id].v).map(id => ({ ...mf.merged[id].v, id, u: mf.merged[id].u })),
    delFolderIds: mf.toLocal.filter(id => localFolder.has(id) && !(mf.merged[id] && mf.merged[id].v)),
  };
  // orders changed here while this ran are kept as they are
  const nowOrders = await MB.loadOrders(), nowTimes = (await MB.getMeta('orderst')) || {};
  for (const k of Object.keys(nowTimes)) if ((nowTimes[k] || 0) !== (snap.orderTimes[k] || 0)) { orders[k] = nowOrders[k]; orderTimes[k] = nowTimes[k]; }
  const applied = await MB.syncCommit(plan);
  const settingsIn = ms.toLocal.includes('settings') && ms.merged.settings && ls.u !== ms.merged.settings.u;
  if (settingsIn) MB.settingsSync.apply(ms.merged.settings.v, ms.merged.settings.u);
  await MB.putMeta('syncbase', newBase);
  for (const id of applied.pieces) {                                // thumbnails are made here, not synced
    try {
      const p = await MB.getPiece(id);
      if (!p || p.thumb) continue;
      const blob = await MB.getFile(p.fileId || p.id), reader = MB.readerById(p.readerId);
      if (!blob || !reader) continue;
      say('Preparing thumbnails…');
      const doc = await reader.open(blob);
      try { const thumb = await doc.thumbnail(360); if (thumb) await MB.setPieceThumb(id, thumb); } finally { doc.destroy?.(); }
    } catch (e) { console.warn('thumbnail failed', e); }
  }
  return { applied, annotations: Object.keys(writeLocal).filter(f => applied.annotations.includes(f)), changedLocal: (settingsIn ? 1 : 0) + applied.pieces.length + applied.folders.length + applied.annotations.length || plan.orders && mo.toLocal.length };
}

// ---- the running service ----
const KEY = 'mb-sync';
const S = {
  creds: null, derived: null, busy: null, error: '', text: '', last: 0, pending: false,
  listeners: [], appliedListeners: [],
};
const emit = () => { for (const f of S.listeners) { try { f(S); } catch (e) { console.warn(e); } } };
const say = t => { S.text = t; emit(); };
async function getDerived() { if (!S.derived) S.derived = derive(S.creds.name, S.creds.pass); return S.derived; }
async function loadCreds() {
  let c = null;
  try { c = await MB.getMeta('sync'); } catch {}
  if (!c) { try { c = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {} }
  if (c && c.name && c.pass) { S.creds = c; S.last = c.last || 0; }
  emit();
  return S.creds;
}
async function saveCreds() {
  const c = S.creds;
  if (!c) { try { localStorage.removeItem(KEY); } catch {} await MB.deleteMeta('sync'); return; }
  try { localStorage.setItem(KEY, JSON.stringify(c)); } catch {}
  await MB.putMeta('sync', c);
}

let applying = false, timer = null, lastRun = 0;
function syncNow() {
  if (!S.creds) return Promise.resolve();
  if (S.busy) { S.pending = true; return S.busy; }
  clearTimeout(timer); timer = null;
  S.error = ''; say('Syncing…');
  S.busy = (async () => {
    const d = await getDerived();
    let res;
    for (let k = 0; ; k++) {
      try { applying = true; res = await attempt(d, S, say); break; }
      catch (e) { if (e instanceof Conflict && k < 4) { say('Syncing…'); continue; } throw e; }
      finally { applying = false; }
    }
    return res;
  })().then(res => {
    S.last = lastRun = Date.now(); S.creds.last = S.last; S.error = ''; S.text = ''; S.busy = null;
    saveCreds().catch(() => {});
    emit();
    if (res && (res.changedLocal || res.annotations.length)) for (const f of S.appliedListeners) { try { f(res); } catch (e) { console.warn(e); } }
    if (S.pending) { S.pending = false; schedule(2000); }
  }, e => {
    S.busy = null; S.text = ''; S.error = e && e.message ? e.message : 'Sync failed.';
    console.warn('sync failed', e);
    emit();
  });
  return S.busy;
}
// changes are synced a little after the last one (and not more than once a minute)
function schedule(delay) {
  if (!S.creds || applying) return;
  clearTimeout(timer);
  const wait = Math.max(delay === undefined ? 15000 : delay, lastRun + 60000 - Date.now());
  timer = setTimeout(() => { timer = null; syncNow(); }, wait);
}

const api = {
  SCHEMA, NAME_MIN, NAME_MAX, WORDS, norm, validName, validPass, randomPassphrase, derive, seal, open, sealJSON, openJSON,
  pickNewer, mergeMaps, mergeItems, localRecords, newAccount, exists, pullManifest, state: S,
  get signedIn() { return !!S.creds; },
  onState(f) { S.listeners.push(f); }, onApplied(f) { S.appliedListeners.push(f); },
  async init() { await loadCreds(); if (S.creds) syncNow(); },
  async connect(name, pass) { S.creds = { v: 1, name: norm(name), pass: norm(pass), last: 0 }; S.derived = null; await saveCreds(); emit(); return syncNow(); },
  async disconnect() { S.creds = null; S.derived = null; S.error = ''; S.text = ''; clearTimeout(timer); await saveCreds(); emit(); },
  syncNow, schedule,
  // delete everything this account has in the store (the library on this device stays as it is)
  async eraseCloud() {
    const d = await getDerived(), { manifest } = await pullManifest(d);
    if (manifest) {
      for (const [fid, info] of Object.entries(manifest.files || {})) for (let k = 0; k < info.n; k++) await call('DELETE', d, 'f.' + fid + '.' + k);
      for (const [fid, a] of Object.entries(manifest.ann || {})) await call('DELETE', d, annName(fid, a.u));
      await call('DELETE', d, 'manifest');
    }
  },
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else {
  MB.Sync = api;
  MB.onChange(() => { if (!applying) schedule(); });
  document.addEventListener('visibilitychange', () => {
    if (!S.creds) return;
    if (document.hidden) { if (timer) { clearTimeout(timer); timer = null; syncNow(); } }
    else if (Date.now() - lastRun > 120000) syncNow();
  });
  window.addEventListener('online', () => { if (S.creds && S.error) syncNow(); });
}
})();
