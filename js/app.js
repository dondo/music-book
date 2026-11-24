(function () {
'use strict';
const {
  listPieces, listFolders, addPiece, addLink, addFolder, updateFolder, deleteFolder, deletePiece, updatePiece,
  trashPiece, restorePiece, trashFolder, restoreFolder, deleteFolderForever,
  setPieceFolder, reorderPieces, loadOrders, getMeta, putMeta, deleteMeta, requestPersistence,
  readerForFile, supportedExtensions, supportedNames,
  Viewer, MidiInput, Bindings, loadSettings, saveSettings, SettingsUI,
} = MB;

const $ = sel => document.querySelector(sel);

// In-page replacements for confirm() and prompt(): some embedded browsers (e.g. MIDIWeb on iPad) silently ignore the native ones.
const askDlg = document.getElementById('ask-dialog');
function askBox(message, { text, label, danger }) {
  return new Promise(resolve => {
    const body = askDlg.querySelector('.ask-body'); body.replaceChildren();
    const msg = document.createElement('p'); msg.textContent = message; body.append(msg);
    let input = null;
    if (text !== undefined) { input = document.createElement('input'); input.type = 'text'; input.value = text; input.className = 'ask-input'; body.append(input); }
    const row = document.createElement('div'); row.className = 'sync-actions';
    const ok = document.createElement('button'); ok.type = 'button'; ok.textContent = label; ok.className = danger ? 'danger' : 'primary';
    const no = document.createElement('button'); no.type = 'button'; no.textContent = 'Cancel';
    row.append(ok, no); body.append(row);
    let done = false;
    const finish = v => { if (done) return; done = true; askDlg.close(); resolve(v); };
    ok.addEventListener('click', () => finish(input ? input.value : true));
    no.addEventListener('click', () => finish(input ? null : false));
    askDlg.addEventListener('cancel', () => finish(input ? null : false), { once: true });
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') ok.click(); });
    askDlg.showModal(); if (input) { input.focus(); input.select(); }
  });
}
const askYes = (message, label = 'OK') => askBox(message, { label, danger: true });
const askText = (message, value) => askBox(message, { text: value, label: 'OK' });

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

// What is open is remembered, so a reload comes back to the same piece (position and zoom are kept per piece by the
// viewer) with the annotation toolbar open or closed as it was. Closing the music clears it.
const SESSION_KEY = 'mb-session';
const saveSession = () => {
  try { if (!viewer.piece) return; } catch { return; }          // (called while the viewer is still being constructed)
  const s = { id: viewer.piece.id, annotating: !!viewer.ann.on, ann: viewer.ann.snapshot() };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
  try { window.name = SESSION_KEY + '=' + JSON.stringify(s); } catch {}              // survives a reload of this tab even where nothing else does
  putMeta('session', s).catch(e => console.warn('Could not remember the open piece:', e));                 // the database is the dependable place (localStorage can be unavailable on file://)
};
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch {} try { window.name = ''; } catch {} deleteMeta('session').catch(() => {}); };

const viewer = new Viewer($('#viewer'), {
  onClose: () => { clearSession(); refreshLibrary(); },
  onOpen: saveSession,
  onAnnotate: saveSession,
  getOptions: () => ({ autoAdvance: !!settings.autoAdvance, hideExtras: !!settings.hideExtras }),
  onOptionChange: o => { Object.assign(settings, o); saveSettings(settings); },
});

MB.viewer = viewer;          // handy for tests and the console
bindings.setHandler('next', () => { if (viewer.isOpen) viewer.next(); });
bindings.setHandler('prev', () => { if (viewer.isOpen) viewer.prev(); });
bindings.setHandler('nextPiece', () => { if (viewer.isOpen) viewer.nextPiece(); });
bindings.setHandler('prevPiece', () => { if (viewer.isOpen) viewer.prevPiece(); });

// Escape always goes up one level: music -> its folder -> library; trash -> library; nothing at the top.
function goUp() {
  if (viewer.isOpen) { viewer.handleEscape(); return; }
  if (inTrash) { inTrash = false; currentFolderId = null; render(); window.scrollTo(0, 0); return; }
  if (currentFolderId !== null) { currentFolderId = null; render(); window.scrollTo(0, 0); }
}

window.addEventListener('keydown', e => {
  if (document.querySelector('dialog[open]')) return;          // dialogs handle Esc themselves
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) {
    e.preventDefault();
    goUp();
    return;
  }
  if (!viewer.isOpen) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '')) return;          // typing a fingering etc.
  if (viewer.ann.handleKey(e)) { e.preventDefault(); return; }               // Move tool: arrows nudge, Delete deletes
  if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && viewer.ann.on) {
    e.preventDefault(); viewer.annotateUndo(); return;
  }
  if (e.metaKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {   // ⌘→ / ⌘← = next / previous piece
    e.preventDefault();                                                    // (also stops browser back/forward)
    e.key === 'ArrowRight' ? viewer.nextPiece() : viewer.prevPiece();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;                          // leave browser shortcuts (⌘0, ⌘-, ⌘+...) alone
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': viewer.next(); break;
    case ' ': e.shiftKey ? viewer.prev() : viewer.next(); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': viewer.prev(); break;
    case ']': viewer.nextPiece(); break;
    case '[': viewer.prevPiece(); break;
    case '+': case '=': viewer.zoomBy(1 / 1.15); break;                    // + = one more line of music on screen
    case '-': case '_': viewer.zoomBy(1.15); break;                        // - = one line fewer
    case '0': viewer.fitWidth(); break;
    case 'a': case 'A': viewer.toggleAnnotate(); break;
    default: return;
  }
  e.preventDefault();
});

$('#settings-btn').addEventListener('click', () => settingsUI.open());

// ---------- library state ----------
let pieces = [];                // live pieces only
let trashed = [];               // every piece in the trash (alone or with its folder), newest first
let trashedFolders = [];        // folders in the trash, newest first
let folders = [];               // live folders only
const expandedTrash = new Set();   // trashed-folder ids shown expanded
let inTrash = false;
let currentFolderId = null;     // null = top level
let thumbURLs = [];
let dragId = null;              // piece id being dragged inside the app

const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
let orders = {};                // folder id -> piece ids in play order (pieces not listed go after them, in the order they were added)
const folderPieces = fid => {
  const rank = new Map((orders[fid ?? ''] || []).map((id, i) => [id, i]));
  return pieces.filter(p => p.folderId === fid)
    .sort((a, b) => ((rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9)) || ((a.order ?? 1e9) - (b.order ?? 1e9)) || byTitle(a, b));
};
const looseTop = () => pieces.filter(p => p.folderId === null).sort(byTitle);
const currentFolder = () => folders.find(f => f.id === currentFolderId) || null;

async function refreshLibrary() {
  const [all, allFolders, ord] = await Promise.all([listPieces(), listFolders(), loadOrders().catch(() => orders)]);
  orders = ord;
  pieces = all.filter(p => !p.trashedAt);
  trashed = all.filter(p => p.trashedAt).sort((x, y) => y.trashedAt - x.trashedAt);
  folders = allFolders.filter(f => !f.trashedAt);
  trashedFolders = allFolders.filter(f => f.trashedAt).sort((x, y) => y.trashedAt - x.trashedAt);
  if (currentFolderId && !currentFolder()) currentFolderId = null;
  render();
}

// what the trash view lists: folders (with their pieces inside) and individually deleted pieces
const trashLoose = () => trashed.filter(p => !p.trashedWithFolder);
const trashItemCount = () => trashLoose().length + trashedFolders.length;

function render() {
  thumbURLs.forEach(URL.revokeObjectURL);
  thumbURLs = [];
  grid.replaceChildren();
  list.replaceChildren();

  const folder = inTrash ? null : currentFolder();
  $('#crumb-folder').textContent = inTrash ? ' / Trash' : (folder ? ' / ' + folder.name : '');
  $('#folder-actions').hidden = !folder;
  $('#new-folder-btn').hidden = !!folder || inTrash;
  $('#upload-btn').hidden = $('#upload-folder-btn').hidden = inTrash;
  $('#empty-trash-btn').hidden = !(inTrash && trashItemCount());
  $('#trash-btn').classList.toggle('active', inTrash);
  $('#trash-btn').classList.toggle('empty', !inTrash && !trashItemCount());      // nothing in it: hidden (it still appears while a piece is dragged, as a place to drop)
  const badge = $('#trash-btn .badge');          // counts pieces, not folders
  badge.hidden = !trashed.length;
  badge.textContent = trashed.length;
  $('#empty-trash').hidden = !(inTrash && !trashItemCount());

  if (inTrash) {
    grid.hidden = true;
    list.hidden = false;
    empty.hidden = true;
    emptyFolder.hidden = true;
    const entries = [
      ...trashedFolders.map(f => ({ at: f.trashedAt, f })),
      ...trashLoose().map(p => ({ at: p.trashedAt, p })),
    ].sort((a, b) => b.at - a.at);
    for (const e of entries) {
      if (e.f) {
        list.append(trashFolderRow(e.f));
        if (expandedTrash.has(e.f.id)) {
          for (const p of trashed.filter(x => x.trashedWithFolder && x.folderId === e.f.id)
            .sort((x, y) => ((x.order ?? 1e9) - (y.order ?? 1e9)))) list.append(trashRow(p, true));
        }
      } else list.append(trashRow(e.p, false));
    }
    return;
  }

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

function button(label, glyph, svg) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  if (svg) b.innerHTML = svg; else b.textContent = glyph;
  return b;
}

// Circled "+" (copy to another folder) and circled arrow (move to another folder).
const circleIcon = sym => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.2"/>${sym === 'plus' ? '<path d="M12 7.6v8.8M7.6 12h8.8"/>' : '<path d="M7.4 12h9M12.9 8l4 4-4 4"/>'}</svg>`;

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
  const arrows = document.createElement('div');
  arrows.className = 'row-arrows';
  const up = button('Move up', '▲');
  const down = button('Move down', '▼');
  up.disabled = i === 0;
  down.disabled = i === items.length - 1;
  up.addEventListener('click', e => { e.stopPropagation(); shift(p, -1); });
  down.addEventListener('click', e => { e.stopPropagation(); shift(p, +1); });
  arrows.append(up, down);
  actions.append(...pieceButtons(p));

  li.append(grip, arrows, num, th, text, actions);
  const openIt = () => openPiece(p);
  li.addEventListener('click', openIt);
  li.addEventListener('keydown', e => { if (e.key === 'Enter') openIt(); });

  li._pid = p.id; li.dataset.folder = p.folderId || '';
  gripDrag(grip, li, p.id);
  li.addEventListener('dragstart', e => {
    dragId = p.id;
    e.dataTransfer.setData('application/x-mb-piece', p.id);
    e.dataTransfer.effectAllowed = 'move';
    startRowDrag(li);
    setTimeout(() => li.classList.add('dragging'), 0);
  });
  li.addEventListener('dragend', () => { dragId = null; endRowDrag(); });
  return li;
}

// Drag to reorder: the other rows slide out of the way to open a gap where the piece will land.
let rowDrag = null;
function startRowDrag(li) {
  const rows = [...list.querySelectorAll(':scope > .row-item')];
  const from = rows.indexOf(li);
  if (from < 0) { rowDrag = null; return; }
  const rects = rows.map(r => r.getBoundingClientRect());
  const step = rects.length > 1 ? rects[1].top - rects[0].top : li.offsetHeight + 8;
  const sy = scroller().scrollTop;
  rowDrag = { li, rows, from, to: from, sy0: sy, mids: rects.map(r => r.top + sy + r.height / 2), step };      // page coordinates, so scrolling while dragging is fine
  rows.forEach(r => { r.style.transition = 'transform .15s ease'; });
}
function endRowDrag() {
  stopAutoScroll();
  if (!rowDrag) return;
  rowDrag.rows.forEach(r => { r.style.transform = ''; r.style.transition = ''; });
  rowDrag.li.classList.remove('dragging');
  rowDrag = null;
}
// Dragging near the top or bottom edge of the window scrolls the page, so a piece can be carried past what is on screen.
const scroller = () => document.scrollingElement || document.documentElement;
let autoRaf = 0, autoY = 0, autoTick = null;
function autoScroll(y, tick) {
  autoY = y; autoTick = tick;
  if (!autoRaf) autoRaf = requestAnimationFrame(autoStep);
}
function autoSpeed() {
  const edge = 90, h = window.innerHeight;
  if (autoY < edge) return -Math.ceil(22 * Math.min(1, (edge - autoY) / edge));
  if (autoY > h - edge) return Math.ceil(22 * Math.min(1, (autoY - (h - edge)) / edge));
  return 0;
}
function autoStep() {
  autoRaf = 0;
  if (!rowDrag) return;
  const v = autoSpeed();
  if (v) {
    const s = scroller(), before = s.scrollTop;
    s.scrollTop = before + v;
    if (s.scrollTop !== before && autoTick) autoTick(autoY);
    autoRaf = requestAnimationFrame(autoStep);
  }
}
function stopAutoScroll() { if (autoRaf) cancelAnimationFrame(autoRaf); autoRaf = 0; autoTick = null; }
function rowDragOver(y) {
  const d = rowDrag; if (!d) return;
  let to = 0;                                              // final index = number of other rows whose centre is above the pointer
  const py = y + scroller().scrollTop;
  d.mids.forEach((m, i) => { if (i !== d.from && m < py) to++; });
  d.to = to;
  d.rows.forEach((r, i) => {
    let dy = 0;
    if (i === d.from) dy = (to - d.from) * d.step;
    else if (to > d.from && i > d.from && i <= to) dy = -d.step;
    else if (to < d.from && i >= to && i < d.from) dy = d.step;
    r.style.transform = dy ? `translateY(${dy}px)` : '';
  });
}
list.addEventListener('dragover', e => {
  if (!dragId || !rowDrag) return;
  e.preventDefault();
  rowDragOver(e.clientY);
  autoScroll(e.clientY, rowDragOver);
});
async function commitRowDrag(id) {
  const { from, to, rows, li } = rowDrag;
  const folderId = li.dataset.folder || null;
  const order = rows.map(r => r._pid);
  endRowDrag();
  if (from === to || order.some(x => !x)) return;
  await reorderIn(folderId, ids => {
    // ids is the folder's current order; the dragged piece lands where the rows showed it
    if (!ids.includes(id) || ids.length !== order.length) return false;
    const others = ids.filter(x => x !== id);
    others.splice(to, 0, id);
    ids.splice(0, ids.length, ...others);
    return true;
  });
}
list.addEventListener('drop', async e => {
  if (!dragId || !rowDrag) return;
  e.preventDefault(); e.stopPropagation();
  const id = dragId; dragId = null;
  await commitRowDrag(id);
});

// Touch screens (iPad) don't start HTML5 drags from a finger in every browser, so the grip also drags by pointer events.
function gripDrag(grip, li, id) {
  grip.style.touchAction = 'none';
  grip.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' || rowDrag) return;          // a mouse uses the normal drag and drop
    e.preventDefault(); e.stopPropagation();
    startRowDrag(li);
    if (!rowDrag) return;
    const y0 = e.clientY, pid = e.pointerId;
    li.classList.add('dragging'); li.style.transition = 'none'; li.style.zIndex = '5';
    try { grip.setPointerCapture(pid); } catch {}
    const sy0 = scroller().scrollTop;
    const place = y => { rowDragOver(y); li.style.transform = `translateY(${y - y0 + scroller().scrollTop - sy0}px)`; };
    const move = ev => {
      if (ev.pointerId !== pid || !rowDrag) return;
      place(ev.clientY);
      autoScroll(ev.clientY, place);
    };
    const done = async ev => {
      if (ev.pointerId !== pid) return;
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', done); grip.removeEventListener('pointercancel', done);
      li.style.zIndex = '';
      if (!rowDrag) return;
      if (ev.type === 'pointercancel') endRowDrag(); else await commitRowDrag(id);
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', done); grip.addEventListener('pointercancel', done);
  });
  grip.addEventListener('click', e => e.stopPropagation());
}

// Reordering always starts from the folder's current order and runs one change at a time, so quick successive clicks
// or drops each act on the result of the one before (never on a stale list).
let reorderQueue = Promise.resolve();
function reorderIn(folderId, change) {
  reorderQueue = reorderQueue.then(async () => {
    const ids = folderPieces(folderId).map(x => x.id);
    if (!change(ids)) return;
    await reorderPieces(folderId, ids);
    await refreshLibrary();
  }).catch(e => { console.error(e); setStatus(`Could not change the order (${e && (e.name || e.message) || e}).`, true); clearStatusSoon(9000); });
  return reorderQueue;
}
function shift(p, delta) {
  return reorderIn(p.folderId, ids => {
    const i = ids.indexOf(p.id), j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return false;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return true;
  });
}

// ----- piece actions -----
function pieceButtons(p) {
  const copy = button('Copy to another folder (shares the same file)…', '', circleIcon('plus'));
  const move = button('Move to folder…', '', circleIcon('arrow'));
  const rename = button('Rename', '✎');
  const del = button('Delete', '🗑');
  copy.addEventListener('click', e => { e.stopPropagation(); movePiece(p, 'copy'); });
  move.addEventListener('click', e => { e.stopPropagation(); movePiece(p, 'move'); });
  rename.addEventListener('click', async e => {
    e.stopPropagation();
    const t = await askText('Title', p.title);
    if (t && t.trim()) { await updatePiece(p.id, { title: t.trim() }); refreshLibrary(); }
  });
  del.addEventListener('click', e => { e.stopPropagation(); removePiece(p); });
  const sep = document.createElement('span');
  sep.className = 'act-sep';
  return [rename, sep, copy, move, del];
}

// Delete = straight to the trash (no questions asked; it can be put back from there).
async function removePiece(p) {
  await trashPiece(p.id);
  setStatus(`“${p.title}” moved to the trash.`);
  clearStatusSoon(3000);
  refreshLibrary();
}

// ----- trash view -----
const shortDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const pagesText = p => `${p.pageCount} page${p.pageCount === 1 ? '' : 's'}`;

function trashButton(label, cls) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = label;
  if (cls) b.className = cls;
  return b;
}

// A piece in the trash. `sub` = it went into the trash together with its folder (shown under that folder).
function trashRow(p, sub) {
  const li = document.createElement('li');
  li.className = 'row-item trash-row' + (sub ? ' trash-sub' : '');
  li.tabIndex = 0;

  const th = document.createElement('div');
  th.className = 'row-thumb';
  const url = thumbURL(p);
  if (url) { const img = document.createElement('img'); img.src = url; img.alt = ''; th.append(img); }
  else th.textContent = '♪';

  const text = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'row-title'; title.textContent = p.title;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  const from = folders.find(f => f.id === p.trashedFrom);
  meta.textContent = sub
    ? pagesText(p)
    : `${pagesText(p)} · deleted ${shortDate(p.trashedAt)} · from ${from ? 'folder “' + from.name + '”' : 'the top level'}`;
  text.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const move = trashButton('Move to…');
  const forever = trashButton('Delete permanently', 'danger');
  move.addEventListener('click', e => { e.stopPropagation(); movePiece(p, 'restore'); });
  forever.addEventListener('click', async e => {
    e.stopPropagation();
    if (await askYes(`Permanently delete “${p.title}”? This can't be undone.`, 'Delete permanently')) { await deletePiece(p.id); refreshLibrary(); }
  });
  if (!sub) {
    const back = trashButton('↩ Put back');
    back.title = from ? `Restore to “${from.name}”` : 'Restore to the top level';
    back.addEventListener('click', async e => { e.stopPropagation(); await restorePiece(p.id, from ? from.id : null); refreshLibrary(); });
    actions.append(back);
  }
  actions.append(move, forever);

  li.append(th, text, actions);
  li.addEventListener('click', () => openPiece(p, [p]));          // preview straight from the trash
  li.addEventListener('keydown', e => { if (e.key === 'Enter') openPiece(p, [p]); });
  return li;
}

// A deleted folder: click to show/hide the pieces that went with it.
function trashFolderRow(f) {
  const kids = trashed.filter(p => p.trashedWithFolder && p.folderId === f.id);
  const li = document.createElement('li');
  li.className = 'row-item trash-row trash-folder';
  li.tabIndex = 0;

  const th = document.createElement('div');
  th.className = 'row-thumb folder-thumb';
  th.textContent = '📁';

  const text = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'row-title';
  title.textContent = (expandedTrash.has(f.id) ? '▾ ' : '▸ ') + f.name;
  const meta = document.createElement('div');
  meta.className = 'row-meta';
  meta.textContent = `folder · ${kids.length} piece${kids.length === 1 ? '' : 's'} · deleted ${shortDate(f.trashedAt)}`;
  text.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const back = trashButton('↩ Put back');
  const forever = trashButton('Delete permanently', 'danger');
  back.title = 'Restore the folder with everything in it';
  back.addEventListener('click', async e => { e.stopPropagation(); await restoreFolder(f.id); refreshLibrary(); });
  forever.addEventListener('click', async e => {
    e.stopPropagation();
    const what = kids.length ? `the folder “${f.name}” and its ${kids.length} piece${kids.length === 1 ? '' : 's'}` : `the folder “${f.name}”`;
    if (await askYes(`Permanently delete ${what}? This can't be undone.`, 'Delete permanently')) { await deleteFolderForever(f.id); refreshLibrary(); }
  });
  actions.append(back, forever);

  li.append(th, text, actions);
  const toggle = () => { expandedTrash.has(f.id) ? expandedTrash.delete(f.id) : expandedTrash.add(f.id); render(); };
  li.addEventListener('click', toggle);
  li.addEventListener('keydown', e => { if (e.key === 'Enter') toggle(); });
  return li;
}

async function emptyTrash() {
  const n = trashItemCount();
  if (!n) return;
  const pieceCount = trashed.length;
  const what = `${trashedFolders.length ? trashedFolders.length + ' folder' + (trashedFolders.length === 1 ? '' : 's') + ' and ' : ''}${pieceCount} piece${pieceCount === 1 ? '' : 's'}`;
  if (!(await askYes(`Permanently delete everything in the trash (${what})? This can't be undone.`, 'Empty trash'))) return;
  for (const f of trashedFolders) await deleteFolderForever(f.id);
  for (const p of trashLoose()) await deletePiece(p.id);
  inTrash = false;                                   // back to the view we were in when we opened the trash
  await refreshLibrary();
  if (currentFolderId && !folders.some(f => f.id === currentFolderId)) currentFolderId = null;
  render(); window.scrollTo(0, 0);
}

$('#empty-trash-btn').addEventListener('click', emptyTrash);
const trashBtn = $('#trash-btn');
document.addEventListener('dragstart', () => setTimeout(() => { if (dragId) document.body.classList.add('piece-dragging'); }, 0), true);
['dragend', 'drop'].forEach(ev => window.addEventListener(ev, () => setTimeout(() => document.body.classList.remove('piece-dragging'), 0), true));
trashBtn.addEventListener('click', () => { inTrash = !inTrash; render(); window.scrollTo(0, 0); });
// drag a piece onto the trash icon to delete it
trashBtn.addEventListener('dragover', e => { if (dragId) { e.preventDefault(); trashBtn.classList.add('drop-target'); } });
trashBtn.addEventListener('dragleave', () => trashBtn.classList.remove('drop-target'));
trashBtn.addEventListener('drop', e => {
  trashBtn.classList.remove('drop-target');
  if (!dragId) return;
  e.preventDefault();
  const p = pieces.find(x => x.id === dragId);
  dragId = null;
  if (p) removePiece(p);
});

// mode 'move': relocate this piece. mode 'copy': add a second placement that shares the same file.
function movePiece(p, mode = 'move') {
  const copying = mode === 'copy';
  const restoring = mode === 'restore';
  const dlg = $('#move-dialog');
  dlg.querySelector('h2').textContent = copying ? 'Copy to…' : restoring ? 'Move out of the trash to…' : 'Move to…';
  const box = dlg.querySelector('.move-list');
  box.replaceChildren();
  const place = (folderId) => copying ? addLink(p.id, folderId) : restoring ? restorePiece(p.id, folderId) : setPieceFolder(p.id, folderId);
  const targets = [{ id: null, name: 'Library (top level)' }, ...folders.map(f => ({ id: f.id, name: '📁 ' + f.name }))];
  for (const t of targets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.name;
    if (!copying && !restoring && t.id === p.folderId) { b.classList.add('current'); b.disabled = true; }
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
    const name = await askText('New folder name', '');
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
  const name = await askText('New folder name', '');
  if (!name || !name.trim()) return;
  await addFolder(name.trim());
  refreshLibrary();
});

async function renameFolder(f) {
  const name = await askText('Folder name', f.name);
  if (name && name.trim()) { await updateFolder(f.id, { name: name.trim() }); refreshLibrary(); }
}

async function removeFolder(f) {
  const n = pieces.filter(p => p.folderId === f.id).length;
  await trashFolder(f.id);
  if (currentFolderId === f.id) currentFolderId = null;
  setStatus(`Folder “${f.name}” (${n} piece${n === 1 ? '' : 's'}) moved to the trash.`);
  clearStatusSoon(3000);
  refreshLibrary();
}

$('#folder-rename').addEventListener('click', () => { const f = currentFolder(); if (f) renameFolder(f); });
$('#folder-delete').addEventListener('click', () => { const f = currentFolder(); if (f) removeFolder(f); });

// crumb: back to top level (also a drop target to take a piece out of its folder)
const crumb = $('#crumb-root');
crumb.addEventListener('click', () => { currentFolderId = null; inTrash = false; render(); });
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
async function openPiece(p, siblingsOverride) {
  try {
    setStatus(`Opening “${p.title}”…`);
    const siblings = siblingsOverride || (p.folderId ? folderPieces(p.folderId) : [p]);
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
// Browsers' own <input webkitdirectory> dialog can't be limited to folders (it ignores `accept` and may let you pick files).
// Where the File System Access API exists (Chrome, Edge) use its folder-only picker; otherwise fall back to the input.
let dirPickerBroken = false;
$('#upload-folder-btn').addEventListener('click', async () => {
  if (!window.showDirectoryPicker || dirPickerBroken) { folderInput.click(); return; }
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'read', id: 'music-book-import' }); }
  catch (e) {
    if (e && e.name === 'AbortError') return;                               // cancelled
    dirPickerBroken = true; folderInput.click(); return;                     // not allowed here: use the basic chooser
  }
  try { await importFromDirectory(dir); } catch (e) { console.error(e); setStatus('Could not read that folder.'); clearStatusSoon(4000); }
});

async function importFromDirectory(dir) {
  const exts = supportedExtensions(), direct = [], nested = [];
  const walk = async (h, depth) => {
    for await (const [name, e] of h.entries()) {
      if (name.startsWith('.')) continue;
      if (e.kind === 'directory') { await walk(e, depth + 1); continue; }
      if (!exts.some(x => name.toLowerCase().endsWith(x))) continue;      // only PDFs / images are ever read
      const f = await e.getFile();
      if (readerForFile(f)) (depth === 0 ? direct : nested).push(f);
    }
  };
  await walk(dir, 0);
  if (currentFolderId && !inTrash) return importMixed([...direct, ...nested].sort(naturalName), []);   // inside a folder: add here
  return importMixed([], [{ name: dir.name, files: direct.sort(naturalName), skippedSubfolders: nested.length }]);
}
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
  if (inTrash) { inTrash = false; render(); }       // dropped music goes to the library, not the trash
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
  if (currentFolderId && !inTrash) {                         // inside a folder: add the PDFs to this folder (folders are one level deep)
    return importMixed(files.filter(f => readerForFile(f)).sort(naturalName), []);
  }
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
  if (!globalThis.crypto?.subtle) return;               // no hashing here (insecure page): don't re-read every file on each load
  for (const p of pieces.filter(x => !x.hash)) {
    try {
      const blob = await MB.getFile(p.fileId);
      const h = blob ? await sha256(blob) : null;
      if (h) { await updatePiece(p.id, { hash: h }); p.hash = h; }
    } catch (e) { console.error(e); }
  }
}

const whereList = ps => {
  const names = [...new Set(ps.map(p => (p.folderId ? `folder “${placeName(p)}”` : 'the top level')))];
  return names.length < 3 ? names.join(' and ') : names.slice(0, -1).join(', ') + ' and ' + names.at(-1);
};

// Resolves to 'here' | 'there' | 'both' | 'cancel'
//   here  = "Only here":  the score ends up only in the destination (removed from everywhere else)
//   there = "Only there": leave things as they are, skip the upload
//   both  = "Both places" / "All places": keep existing placements and add one here, named after the file
function askDuplicates(dups, total) {
  return new Promise(resolve => {
    const dlg = $('#dup-dialog');
    const multi = dups.some(d => d.placements.length > 1);
    const extraCopies = dups.reduce((n, d) => n + d.placements.length - 1, 0);
    dlg.querySelector('.dup-summary').textContent =
      `${dups.length} of ${total} file${total === 1 ? '' : 's'} ${dups.length === 1 ? 'is' : 'are'} identical to music you already have` +
      (multi ? ` (some are already in several places — ${dups.reduce((n, d) => n + d.placements.length, 0)} copies in all)` : '') + ':';
    const ul = dlg.querySelector('.dup-list');
    ul.replaceChildren();
    for (const d of dups.slice(0, 8)) {
      const li = document.createElement('li');
      const n = d.placements.length;
      const already = d.job.name === null && d.placements.some(p => p.folderId === currentFolderId);
      const newName = titleFromName(d.file.name);
      li.textContent = `${d.file.name} — already in ${n > 1 ? n + ' places: ' : ''}${whereList(d.placements)}` +
        (already ? ' (one is already here)' : '') +
        (newName !== d.placements[0].title ? ` — a new copy here would be named “${newName}”` : '');
      ul.append(li);
    }
    if (dups.length > 8) {
      const li = document.createElement('li');
      li.textContent = `…and ${dups.length - 8} more`;
      ul.append(li);
    }
    dlg.querySelector('.dup-both').textContent = multi ? 'All places' : 'Both places';
    const hint = dlg.querySelector('.dup-hint');
    hint.replaceChildren();
    const add = (b, t) => { const e = document.createElement('b'); e.textContent = b; hint.append(e, ' ' + t + ' '); };
    add('Only here', `moves it here and removes it from ${multi ? 'every other place' : 'the other place'} (set lists included).`);
    add('Only there', 'leaves everything as it is and skips the upload.');
    add(multi ? 'All places' : 'Both places', 'keeps the existing copies and adds one here, named after the file; the file is stored once.');

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
  const stats = { added: 0, linked: 0, moved: 0, removed: 0, skipped: 0 };
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
      if (choice === 'there') acts.set(d.file, { kind: 'skip' });
      else if (choice === 'here') acts.set(d.file, { kind: 'only', pieces: d.placements });
      else acts.set(d.file, alreadyHere ? { kind: 'skip' } : { kind: 'link', piece: target });   // both / all places
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
    for (const k of ['added', 'linked', 'moved', 'removed', 'skipped']) stats[k] += r[k];
    problems.push(...r.problems);
  }

  requestPersistence();
  await refreshLibrary();
  const parts = [];
  if (stats.added || !(stats.linked || stats.moved || stats.skipped)) parts.push(`Added ${stats.added}`);
  if (stats.linked) parts.push(`${stats.linked} shared cop${stats.linked === 1 ? 'y' : 'ies'} added`);
  if (stats.moved) parts.push(`${stats.moved} now only here` + (stats.removed ? ` (removed from ${stats.removed} other place${stats.removed === 1 ? '' : 's'})` : ''));
  if (stats.skipped) parts.push(`${stats.skipped} duplicate${stats.skipped === 1 ? '' : 's'} skipped`);
  const folderNote = madeFolders ? ` (${madeFolders} new folder${madeFolders === 1 ? '' : 's'})` : '';
  const text = parts.join(', ') + folderNote + '.';
  if (problems.length) setStatus(`${text} Notes — ${problems.join('; ')}`, true);
  else { setStatus(text); clearStatusSoon(4000); }
}

async function refreshFolders() { folders = (await listFolders()).filter(f => !f.trashedAt); }

// New music goes into whatever folder is open (at the end of its order).
function importFiles(files) {
  if (!files.length) return Promise.resolve();
  return importMixed(files, []);
}

async function importBatch(files, folderId, label, hashes = new Map(), acts = new Map(), created = new Map()) {
  const problems = [];
  const r = { added: 0, linked: 0, moved: 0, removed: 0, skipped: 0, problems };
  for (const [i, file] of files.entries()) {
    setStatus(`Importing ${label ? label + ': ' : ''}${i + 1} of ${files.length}: ${file.name}…`);
    const act = acts.get(file);
    const name = titleFromName(file.name);       // a new placement is named after the file that was imported
    try {
      if (act?.kind === 'only') {
        // keep one placement (the one already here, else the first), put it here, remove all the others
        const keep = act.pieces.find(p => p.folderId === folderId) || act.pieces[0];
        let changed = false;
        if (keep.folderId !== folderId) { await setPieceFolder(keep.id, folderId); changed = true; }
        for (const other of act.pieces) {
          if (other.id === keep.id) continue;
          await deletePiece(other.id);
          r.removed++;
          changed = true;
        }
        changed ? r.moved++ : r.skipped++;
        continue;
      }
      if (act?.kind === 'link') { await addLink(act.piece.id, folderId, name); r.linked++; continue; }
      if (act?.kind === 'linkHash') {
        const src = created.get(act.hash);
        if (src) { await addLink(src.id, folderId, name); r.linked++; }
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

const libraryLoaded = refreshLibrary();                       // the library is on screen after this
const libraryReady = libraryLoaded.then(backfillHashes);      // (hashing old pieces carries on quietly afterwards)

// Reload: go back to the piece that was open.
(async () => {
  await libraryLoaded;
  let s = null;
  try { s = await getMeta('session'); } catch {}
  if (!s) { try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch {} }
  if (!s) { try { if (window.name.startsWith(SESSION_KEY + '=')) s = JSON.parse(window.name.slice(SESSION_KEY.length + 1)); } catch {} }
  if (!s) return;
  const p = pieces.find(x => x.id === s.id);
  if (!p) { clearSession(); return; }
  try {
    currentFolderId = p.folderId && folders.some(f => f.id === p.folderId) ? p.folderId : null;
    render();
    await openPiece(p);
    if (viewer.isOpen) viewer.ann.applySnapshot(s.ann);
    if (s.annotating && viewer.isOpen) viewer.ann.setOn(true);
  } catch (e) { console.error(e); setStatus(`Couldn't reopen the piece: ${e && (e.message || e)}`, true); }
})().catch(e => { console.error(e); setStatus(`Couldn't restore the open piece: ${e && (e.message || e)}`, true); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ---- sync across devices ----
// Synced changes refresh the library and the markings of the open piece; a signed-in device syncs at start-up.
MB.Sync.onApplied(async res => {
  try { await refreshLibrary(); } catch (e) { console.warn(e); }
  const open = MB.viewer && MB.viewer.ann && MB.viewer.ann.anns;
  if (open && res.annotations.includes(open.fileId)) { try { await MB.viewer.ann.reloadFrom(open.fileId); } catch (e) { console.warn(e); } }
});
libraryLoaded.then(() => MB.Sync.init());
})();
