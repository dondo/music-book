(function () {
'use strict';
const {
  listPieces, listFolders, addPiece, addLink, addFolder, updateFolder, deleteFolder, deletePiece, updatePiece,
  setPieceFolder, reorderPieces, requestPersistence,
  readerForFile, supportedExtensions, supportedNames,
  Viewer, MidiInput, Bindings, loadSettings, SettingsUI,
} = MB;

const $ = sel => document.querySelector(sel);
const grid = $('#grid');
const list = $('#list');
const empty = $('#empty');
const emptyFolder = $('#empty-folder');
const statusEl = $('#status');
const fileInput = $('#file-input');

fileInput.accept = supportedExtensions().join(',');
$('#formats').textContent = supportedNames();

// ---------- input wiring ----------
const settings = loadSettings();
const midi = new MidiInput();
midi.enabled = settings.midiInputs;
const bindings = new Bindings(midi, settings);
const settingsUI = new SettingsUI($('#settings'), midi, bindings);
midi.init().then(() => { midi.setEnabled(settings.midiInputs); });

const viewer = new Viewer($('#viewer'), {
  onClose: () => refreshLibrary(),
  getOptions: () => ({ autoAdvance: !!settings.autoAdvance }),
});

bindings.setHandler('next', () => { if (viewer.isOpen) viewer.next(); });
bindings.setHandler('prev', () => { if (viewer.isOpen) viewer.prev(); });
bindings.setHandler('nextPiece', () => { if (viewer.isOpen) viewer.nextPiece(); });
bindings.setHandler('prevPiece', () => { if (viewer.isOpen) viewer.prevPiece(); });

window.addEventListener('keydown', e => {
  if ($('#settings').open || $('#move-dialog').open) return;
  if (!viewer.isOpen) return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': viewer.next(); break;
    case ' ': e.shiftKey ? viewer.prev() : viewer.next(); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': viewer.prev(); break;
    case ']': viewer.nextPiece(); break;
    case '[': viewer.prevPiece(); break;
    case 'Escape': viewer.close(); break;
    default: return;
  }
  e.preventDefault();
});

$('#settings-btn').addEventListener('click', () => settingsUI.open());

// ---------- library state ----------
let pieces = [];
let folders = [];
let currentFolderId = null;     // null = top level
let thumbURLs = [];
let dragId = null;              // piece id being dragged inside the app

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
const folderPieces = fid => pieces.filter(p => p.folderId === fid)
  .sort((a, b) => ((a.order ?? 1e9) - (b.order ?? 1e9)) || byTitle(a, b));
const looseTop = () => pieces.filter(p => p.folderId === null).sort(byTitle);
const currentFolder = () => folders.find(f => f.id === currentFolderId) || null;

async function refreshLibrary() {
  [pieces, folders] = await Promise.all([listPieces(), listFolders()]);
  if (currentFolderId && !currentFolder()) currentFolderId = null;
  render();
}

function render() {
  thumbURLs.forEach(URL.revokeObjectURL);
  thumbURLs = [];
  grid.replaceChildren();
  list.replaceChildren();

  const folder = currentFolder();
  $('#crumb-folder').textContent = folder ? ' / ' + folder.name : '';
  $('#folder-actions').hidden = !folder;
  $('#new-folder-btn').hidden = !!folder;
  grid.hidden = !!folder;
  list.hidden = !folder;

  if (folder) {
    const items = folderPieces(folder.id);
    empty.hidden = true;
    emptyFolder.hidden = items.length > 0;
    items.forEach((p, i) => list.append(row(p, i, items)));
  } else {
    emptyFolder.hidden = true;
    empty.hidden = pieces.length > 0 || folders.length > 0;
    for (const f of folders) grid.append(folderCard(f));
    for (const p of looseTop()) grid.append(card(p));
  }
}

function thumbURL(p) {
  if (!p.thumb) return null;
  const url = URL.createObjectURL(p.thumb);
  thumbURLs.push(url);
  return url;
}

function button(label, glyph) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.textContent = glyph;
  return b;
}

const othersOf = p => pieces.filter(q => q.id !== p.id && q.fileId === p.fileId);
function placeName(q) {
  const f = q.folderId && folders.find(x => x.id === q.folderId);
  return f ? f.name : 'top level';
}
function metaText(p) {
  let t = `${p.pageCount} page${p.pageCount === 1 ? '' : 's'}` + (p.lastPage > 1 ? ` · on p. ${p.lastPage}` : '');
  const o = othersOf(p);
  if (o.length) t += ` · 🔗 also in ${[...new Set(o.map(placeName))].join(', ')}`;
  return t;
}

// ----- top-level cards -----
function folderCard(f) {
  const n = pieces.filter(p => p.folderId === f.id).length;
  const li = document.createElement('li');
  li.className = 'card folder';
  li.tabIndex = 0;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.textContent = '📁';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = f.name;
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${n} piece${n === 1 ? '' : 's'}`;

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const rename = button('Rename folder', '✎');
  const del = button('Delete folder', '🗑');
  rename.addEventListener('click', e => { e.stopPropagation(); renameFolder(f); });
  del.addEventListener('click', e => { e.stopPropagation(); removeFolder(f); });
  actions.append(rename, del);

  li.append(thumb, title, meta, actions);
  const openIt = () => { currentFolderId = f.id; render(); window.scrollTo(0, 0); };
  li.addEventListener('click', openIt);
  li.addEventListener('keydown', e => { if (e.key === 'Enter') openIt(); });

  // drop a piece onto a folder to move it in
  li.addEventListener('dragover', e => { if (dragId) { e.preventDefault(); li.classList.add('drop-target'); } });
  li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
  li.addEventListener('drop', async e => {
    li.classList.remove('drop-target');
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragId; dragId = null;
    await setPieceFolder(id, f.id);
    refreshLibrary();
  });
  return li;
}

function card(p) {
  const li = document.createElement('li');
  li.className = 'card';
  li.tabIndex = 0;
  li.draggable = true;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  const url = thumbURL(p);
  if (url) {
    const img = document.createElement('img');
    img.src = url; img.alt = ''; img.draggable = false;
    thumb.append(img);
  } else thumb.textContent = '♪';

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = p.title;
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = metaText(p);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.append(...pieceButtons(p));

  li.append(thumb, title, meta, actions);
  const openIt = () => openPiece(p);
  li.addEventListener('click', openIt);
  li.addEventListener('keydown', e => { if (e.key === 'Enter') openIt(); });
  li.addEventListener('dragstart', e => { dragId = p.id; e.dataTransfer.setData('application/x-mb-piece', p.id); e.dataTransfer.effectAllowed = 'move'; });
  li.addEventListener('dragend', () => { dragId = null; });
  return li;
}

// ----- ordered rows inside a folder -----
function row(p, i, items) {
  const li = document.createElement('li');
  li.className = 'row-item';
  li.tabIndex = 0;
  li.draggable = true;

  const grip = document.createElement('div');
  grip.className = 'grip'; grip.textContent = '⋮⋮'; grip.title = 'Drag to reorder';
  const num = document.createElement('div');
  num.className = 'row-num'; num.textContent = i + 1;

  const th = document.createElement('div');
  th.className = 'row-thumb';
  const url = thumbURL(p);
  if (url) { const img = document.createElement('img'); img.src = url; img.alt = ''; img.draggable = false; th.append(img); }
  else th.textContent = '♪';

  const text = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'row-title'; title.textContent = p.title;
  const meta = document.createElement('div');
  meta.className = 'row-meta'; meta.textContent = metaText(p);
  text.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const up = button('Move up', '▲');
  const down = button('Move down', '▼');
  up.disabled = i === 0;
  down.disabled = i === items.length - 1;
  up.addEventListener('click', e => { e.stopPropagation(); shift(items, i, -1); });
  down.addEventListener('click', e => { e.stopPropagation(); shift(items, i, +1); });
  actions.append(up, down, ...pieceButtons(p));

  li.append(grip, num, th, text, actions);
  const openIt = () => openPiece(p);
  li.addEventListener('click', openIt);
  li.addEventListener('keydown', e => { if (e.key === 'Enter') openIt(); });

  li.addEventListener('dragstart', e => {
    dragId = p.id;
    e.dataTransfer.setData('application/x-mb-piece', p.id);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => li.classList.add('dragging'), 0);
  });
  li.addEventListener('dragend', () => {
    dragId = null;
    li.classList.remove('dragging');
    list.querySelectorAll('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after'));
  });
  li.addEventListener('dragover', e => {
    if (!dragId || dragId === p.id) return;
    e.preventDefault();
    const r = li.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    li.classList.toggle('drop-before', before);
    li.classList.toggle('drop-after', !before);
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
  li.addEventListener('drop', async e => {
    const before = li.classList.contains('drop-before');
    li.classList.remove('drop-before', 'drop-after');
    if (!dragId || dragId === p.id) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragId; dragId = null;
    const ids = items.map(x => x.id);
    if (!ids.includes(id)) return;                 // came from outside this folder
    ids.splice(ids.indexOf(id), 1);
    ids.splice(ids.indexOf(p.id) + (before ? 0 : 1), 0, id);
    await reorderPieces(ids);
    refreshLibrary();
  });
  return li;
}

async function shift(items, i, delta) {
  const ids = items.map(x => x.id);
  const j = i + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  await reorderPieces(ids);
  refreshLibrary();
}

// ----- piece actions -----
function pieceButtons(p) {
  const copy = button('Copy to another folder (shares the same file)…', '🔗');
  const move = button('Move to folder…', '📂');
  const rename = button('Rename', '✎');
  const del = button('Delete', '🗑');
  copy.addEventListener('click', e => { e.stopPropagation(); movePiece(p, 'copy'); });
  move.addEventListener('click', e => { e.stopPropagation(); movePiece(p, 'move'); });
  rename.addEventListener('click', async e => {
    e.stopPropagation();
    const t = prompt('Title', p.title);
    if (t && t.trim()) { await updatePiece(p.id, { title: t.trim() }); refreshLibrary(); }
  });
  del.addEventListener('click', async e => {
    e.stopPropagation();
    const o = othersOf(p);
    const msg = o.length
      ? `Remove “${p.title}” from ${placeName(p) === 'top level' ? 'the top level' : 'folder “' + placeName(p) + '”'}? It stays in: ${[...new Set(o.map(placeName))].join(', ')}. (The file itself is deleted only when its last copy is removed.)`
      : `Delete “${p.title}” from the library?`;
    if (confirm(msg)) { await deletePiece(p.id); refreshLibrary(); }
  });
  return [copy, move, rename, del];
}

// mode 'move': relocate this piece. mode 'copy': add a second placement that shares the same file.
function movePiece(p, mode = 'move') {
  const copying = mode === 'copy';
  const dlg = $('#move-dialog');
  dlg.querySelector('h2').textContent = copying ? 'Copy to…' : 'Move to…';
  const box = dlg.querySelector('.move-list');
  box.replaceChildren();
  const place = (folderId) => copying ? addLink(p.id, folderId) : setPieceFolder(p.id, folderId);
  const targets = [{ id: null, name: 'Library (top level)' }, ...folders.map(f => ({ id: f.id, name: '📁 ' + f.name }))];
  for (const t of targets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.name;
    if (!copying && t.id === p.folderId) { b.classList.add('current'); b.disabled = true; }
    b.addEventListener('click', async () => {
      dlg.close();
      await place(t.id);
      refreshLibrary();
    });
    box.append(b);
  }
  const nb = document.createElement('button');
  nb.type = 'button';
  nb.textContent = '+ New folder…';
  nb.addEventListener('click', async () => {
    const name = prompt('New folder name');
    if (!name || !name.trim()) return;
    dlg.close();
    const f = await addFolder(name.trim());
    await place(f.id);
    refreshLibrary();
  });
  box.append(nb);
  dlg.showModal();
}
$('#move-dialog .move-cancel').addEventListener('click', () => $('#move-dialog').close());

// ----- folder actions -----
$('#new-folder-btn').addEventListener('click', async () => {
  const name = prompt('New folder name');
  if (!name || !name.trim()) return;
  await addFolder(name.trim());
  refreshLibrary();
});

async function renameFolder(f) {
  const name = prompt('Folder name', f.name);
  if (name && name.trim()) { await updateFolder(f.id, { name: name.trim() }); refreshLibrary(); }
}

async function removeFolder(f) {
  const n = pieces.filter(p => p.folderId === f.id).length;
  const msg = n
    ? `Delete the folder “${f.name}”? Its ${n} piece${n === 1 ? '' : 's'} will move to the top level of the library (no music is deleted).`
    : `Delete the empty folder “${f.name}”?`;
  if (!confirm(msg)) return;
  await deleteFolder(f.id);
  if (currentFolderId === f.id) currentFolderId = null;
  refreshLibrary();
}

$('#folder-rename').addEventListener('click', () => { const f = currentFolder(); if (f) renameFolder(f); });
$('#folder-delete').addEventListener('click', () => { const f = currentFolder(); if (f) removeFolder(f); });

// crumb: back to top level (also a drop target to take a piece out of its folder)
const crumb = $('#crumb-root');
crumb.addEventListener('click', () => { currentFolderId = null; render(); });
crumb.addEventListener('dragover', e => { if (dragId && currentFolderId) { e.preventDefault(); crumb.classList.add('drop-target'); } });
crumb.addEventListener('dragleave', () => crumb.classList.remove('drop-target'));
crumb.addEventListener('drop', async e => {
  crumb.classList.remove('drop-target');
  if (!dragId) return;
  e.preventDefault();
  const id = dragId; dragId = null;
  await setPieceFolder(id, null);
  refreshLibrary();
});

// ----- opening -----
async function openPiece(p) {
  try {
    setStatus(`Opening “${p.title}”…`);
    const siblings = p.folderId ? folderPieces(p.folderId) : [p];
    await viewer.open(p, siblings);
    setStatus('');
  } catch (e) {
    console.error(e);
    setStatus(`Couldn't open “${p.title}”: ${e.message}`, true);
  }
}

// ---------- upload ----------
const folderInput = $('#folder-input');
$('#upload-btn').addEventListener('click', () => fileInput.click());
$('#upload-folder-btn').addEventListener('click', () => folderInput.click());
$('#empty-upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { importFiles([...fileInput.files]); fileInput.value = ''; });
folderInput.addEventListener('change', () => { importFromPicker([...folderInput.files]); folderInput.value = ''; });

const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', async e => {
  document.body.classList.remove('dragging');
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (viewer.isOpen) return;
  // entries must be grabbed synchronously, before any await
  const entries = [...(e.dataTransfer.items || [])]
    .filter(i => i.kind === 'file')
    .map(i => i.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) { importFiles([...e.dataTransfer.files]); return; }

  const looseFiles = [];
  const groups = [];
  const skippedSub = { n: 0 };
  for (const entry of entries) {
    if (entry.isFile) { looseFiles.push(await entryFile(entry)); continue; }
    const kids = await readAllEntries(entry.createReader());
    const files = [];
    for (const k of kids) {
      if (k.isFile) files.push(await entryFile(k));
      else skippedSub.n++;
    }
    groups.push({ name: entry.name, files, skippedSubfolders: skippedSub.n });
    skippedSub.n = 0;
  }
  await importMixed(looseFiles, groups);
});

function entryFile(entry) { return new Promise((res, rej) => entry.file(res, rej)); }
function readAllEntries(reader) {
  return new Promise((res, rej) => {
    const out = [];
    (function next() {
      reader.readEntries(es => { if (!es.length) res(out); else { out.push(...es); next(); } }, rej);
    })();
  });
}

// <input webkitdirectory>: files carry webkitRelativePath = "Folder/file.pdf" (deeper = subfolder)
function importFromPicker(files) {
  const groups = new Map();
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    const root = parts.length > 1 ? parts[0] : 'New folder';
    if (!groups.has(root)) groups.set(root, { name: root, files: [], skippedSubfolders: 0 });
    const g = groups.get(root);
    if (parts.length <= 2) g.files.push(f);
    else if (readerForFile(f)) g.skippedSubfolders++;       // supported file inside a subfolder
  }
  return importMixed([], [...groups.values()]);
}

const naturalName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function uniqueFolderName(name) {
  const taken = new Set(folders.map(f => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
}

// ---------- duplicate detection ----------
// A SHA-256 of the file's bytes identifies "the same file" whatever it is called.
// (A re-saved or re-exported copy of the same score has different bytes, so it won't match.)
async function sha256(blob) {
  if (!globalThis.crypto?.subtle) return null;              // needs a secure context (https or file://)
  try {
    const d = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

// Pieces added before this feature have no hash yet: compute them once in the background.
async function backfillHashes() {
  for (const p of pieces.filter(x => !x.hash)) {
    try {
      const blob = await MB.getFile(p.fileId);
      const h = blob ? await sha256(blob) : null;
      if (h) { await updatePiece(p.id, { hash: h }); p.hash = h; }
    } catch (e) { console.error(e); }
  }
}

const whereList = ps => [...new Set(ps.map(p => (p.folderId ? `folder “${placeName(p)}”` : 'the top level')))].join(' and ');

// Resolves to 'here' | 'there' | 'both' | 'cancel'
function askDuplicates(dups, total) {
  return new Promise(resolve => {
    const dlg = $('#dup-dialog');
    dlg.querySelector('.dup-summary').textContent =
      `${dups.length} of ${total} file${total === 1 ? '' : 's'} ${dups.length === 1 ? 'is' : 'are'} identical to music you already have:`;
    const ul = dlg.querySelector('.dup-list');
    ul.replaceChildren();
    for (const d of dups.slice(0, 8)) {
      const li = document.createElement('li');
      const already = d.job.name === null && d.placements.some(p => p.folderId === currentFolderId);
      li.textContent = `${d.file.name} — already in ${whereList(d.placements)}${already ? ' (already here, so it will be skipped)' : ''}`;
      ul.append(li);
    }
    if (dups.length > 8) {
      const li = document.createElement('li');
      li.textContent = `…and ${dups.length - 8} more`;
      ul.append(li);
    }
    let choice = 'cancel';                                  // Esc = cancel
    const done = c => { choice = c; dlg.close(); };
    dlg.querySelector('.dup-here').onclick = () => done('here');
    dlg.querySelector('.dup-there').onclick = () => done('there');
    dlg.querySelector('.dup-both').onclick = () => done('both');
    dlg.querySelector('.dup-cancel').onclick = () => done('cancel');
    dlg.onclose = () => resolve(choice);
    dlg.showModal();
  });
}

// Each dropped/picked folder becomes a new library folder holding its supported files,
// ordered by file name (natural sort, so "2 ..." comes before "10 ...").
async function importMixed(looseFiles, groups) {
  await libraryReady;
  const problems = [];
  const stats = { added: 0, linked: 0, moved: 0, skipped: 0 };
  let madeFolders = 0;

  // 1. plan the jobs: loose files go into the open folder, each dropped folder becomes a new one
  const jobs = [];
  if (looseFiles.length) jobs.push({ name: null, files: looseFiles });
  for (const g of groups) {
    const usable = g.files.filter(f => readerForFile(f)).sort(naturalName);
    const ignored = g.files.length - usable.length;
    if (!usable.length) { problems.push(`${g.name}: no supported files (${supportedNames()})`); continue; }
    if (ignored) problems.push(`${g.name}: ${ignored} unsupported file${ignored === 1 ? '' : 's'} skipped`);
    if (g.skippedSubfolders) problems.push(`${g.name}: files inside subfolders were not imported`);
    jobs.push({ name: g.name, files: usable });
  }

  // 2. hash everything and look for duplicates (of the library, and within this import)
  const hashes = new Map();
  const all = jobs.flatMap(j => j.files).filter(f => readerForFile(f));
  if (all.length) setStatus('Checking for duplicates…');
  for (const f of all) hashes.set(f, await sha256(f));

  const libByHash = new Map();
  for (const p of pieces) if (p.hash) { if (!libByHash.has(p.hash)) libByHash.set(p.hash, []); libByHash.get(p.hash).push(p); }
  const acts = new Map();             // File -> { kind: 'skip' | 'link' | 'move' | 'linkHash', piece?, hash? }
  const inBatch = new Map();          // hash -> job that first brought it in this import
  const dups = [];
  for (const j of jobs) {
    for (const f of j.files) {
      const h = hashes.get(f);
      if (!h) continue;
      if (libByHash.has(h)) dups.push({ file: f, job: j, placements: libByHash.get(h) });
      else if (inBatch.has(h)) acts.set(f, inBatch.get(h) === j ? { kind: 'skip' } : { kind: 'linkHash', hash: h });
      else inBatch.set(h, j);
    }
  }

  if (dups.length) {
    setStatus('');
    const choice = await askDuplicates(dups, all.length);
    if (choice === 'cancel') { setStatus('Import cancelled.'); clearStatusSoon(3000); return; }
    const firstJob = new Map();
    for (const d of dups) {
      const h = hashes.get(d.file);
      const target = d.placements[0];
      const alreadyHere = d.job.name === null && d.placements.some(p => p.folderId === currentFolderId);
      if (firstJob.has(h)) {                               // same file twice in this import
        acts.set(d.file, firstJob.get(h) === d.job ? { kind: 'skip' } : { kind: 'link', piece: target });
        continue;
      }
      firstJob.set(h, d.job);
      if (choice === 'there' || alreadyHere) acts.set(d.file, { kind: 'skip' });
      else if (choice === 'here' && d.placements.length === 1) acts.set(d.file, { kind: 'move', piece: target });
      else acts.set(d.file, { kind: 'link', piece: target });   // 'both', or a score already in several places
    }
  }

  // 3. import, in file-name order within each job
  const created = new Map();          // hash -> piece created in this import (for links between jobs)
  for (const j of jobs) {
    const live = j.files.filter(f => acts.get(f)?.kind !== 'skip');
    stats.skipped += j.files.length - live.length;
    if (!live.length) continue;                             // nothing to put there: no empty folder
    let folderId = currentFolderId;
    if (j.name !== null) {
      await refreshFolders();
      const folder = await addFolder(uniqueFolderName(j.name));
      folders.push(folder);
      folderId = folder.id;
      madeFolders++;
    }
    const r = await importBatch(live, folderId, j.name, hashes, acts, created);
    for (const k of ['added', 'linked', 'moved']) stats[k] += r[k];
    problems.push(...r.problems);
  }

  requestPersistence();
  await refreshLibrary();
  const parts = [];
  if (stats.added || !(stats.linked || stats.moved || stats.skipped)) parts.push(`Added ${stats.added}`);
  if (stats.linked) parts.push(`${stats.linked} shared cop${stats.linked === 1 ? 'y' : 'ies'} added`);
  if (stats.moved) parts.push(`${stats.moved} moved here`);
  if (stats.skipped) parts.push(`${stats.skipped} duplicate${stats.skipped === 1 ? '' : 's'} skipped`);
  const folderNote = madeFolders ? ` (${madeFolders} new folder${madeFolders === 1 ? '' : 's'})` : '';
  const text = parts.join(', ') + folderNote + '.';
  if (problems.length) setStatus(`${text} Notes — ${problems.join('; ')}`, true);
  else { setStatus(text); clearStatusSoon(4000); }
}

async function refreshFolders() { folders = await listFolders(); }

// New music goes into whatever folder is open (at the end of its order).
function importFiles(files) {
  if (!files.length) return Promise.resolve();
  return importMixed(files, []);
}

async function importBatch(files, folderId, label, hashes = new Map(), acts = new Map(), created = new Map()) {
  const problems = [];
  const r = { added: 0, linked: 0, moved: 0, problems };
  for (const [i, file] of files.entries()) {
    setStatus(`Importing ${label ? label + ': ' : ''}${i + 1} of ${files.length}: ${file.name}…`);
    const act = acts.get(file);
    try {
      if (act?.kind === 'move') { await setPieceFolder(act.piece.id, folderId); r.moved++; continue; }
      if (act?.kind === 'link') { await addLink(act.piece.id, folderId); r.linked++; continue; }
      if (act?.kind === 'linkHash') {
        const src = created.get(act.hash);
        if (src) { await addLink(src.id, folderId); r.linked++; }
        continue;
      }
    } catch (e) { console.error(e); problems.push(`${file.name}: ${e.message || 'could not be placed'}`); continue; }

    const reader = readerForFile(file);
    if (!reader) { problems.push(`${file.name}: unsupported format`); continue; }
    let doc;
    try {
      doc = await reader.open(file);
      const thumb = await doc.thumbnail(360).catch(() => null);
      const piece = await addPiece({
        title: titleFromName(file.name),
        readerId: reader.id,
        blob: file,
        pageCount: doc.pageCount,
        thumb,
        folderId,
        hash: hashes.get(file) ?? null,
      });
      if (piece.hash) created.set(piece.hash, piece);
      r.added++;
    } catch (e) {
      console.error(e);
      problems.push(`${file.name}: ${e.message || 'could not be read'}`);
    } finally {
      doc?.destroy();
    }
  }
  return r;
}

function titleFromName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name;
}

let statusTimer = null;
function clearStatusSoon(ms) { clearTimeout(statusTimer); statusTimer = setTimeout(() => setStatus(''), ms); }

function setStatus(text, isError = false) {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !text;
}

const libraryReady = refreshLibrary().then(backfillHashes);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
})();
