(function () {
'use strict';
const { listPieces, addPiece, deletePiece, updatePiece, requestPersistence, readerForFile, supportedExtensions, supportedNames, Viewer, MidiInput, Bindings, loadSettings, SettingsUI } = MB;

const $ = sel => document.querySelector(sel);
const grid = $('#grid');
const empty = $('#empty');
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

const viewer = new Viewer($('#viewer'), { onClose: () => refreshLibrary() });

bindings.setHandler('next', () => { if (viewer.isOpen) viewer.next(); });
bindings.setHandler('prev', () => { if (viewer.isOpen) viewer.prev(); });

window.addEventListener('keydown', e => {
  if ($('#settings').open) return;
  if (!viewer.isOpen) return;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': case 'PageDown': viewer.next(); break;
    case ' ': e.shiftKey ? viewer.prev() : viewer.next(); break;
    case 'ArrowLeft': case 'ArrowUp': case 'PageUp': viewer.prev(); break;
    case 'Escape': viewer.close(); break;
    default: return;
  }
  e.preventDefault();
});

$('#settings-btn').addEventListener('click', () => settingsUI.open());

// ---------- library ----------
let thumbURLs = [];

async function refreshLibrary() {
  const pieces = await listPieces();
  thumbURLs.forEach(URL.revokeObjectURL);
  thumbURLs = [];
  grid.replaceChildren();
  empty.hidden = pieces.length > 0;
  for (const p of pieces) grid.append(card(p));
}

function card(p) {
  const li = document.createElement('li');
  li.className = 'card';
  li.tabIndex = 0;

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (p.thumb) {
    const url = URL.createObjectURL(p.thumb);
    thumbURLs.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    thumb.append(img);
  } else {
    thumb.textContent = '♪';
  }

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = p.title;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = `${p.pageCount} page${p.pageCount === 1 ? '' : 's'}` + (p.lastPage > 1 ? ` · on p. ${p.lastPage}` : '');

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const rename = button('Rename', '✎');
  const del = button('Delete', '🗑');
  rename.addEventListener('click', async e => {
    e.stopPropagation();
    const t = prompt('Title', p.title);
    if (t && t.trim()) { await updatePiece(p.id, { title: t.trim() }); refreshLibrary(); }
  });
  del.addEventListener('click', async e => {
    e.stopPropagation();
    if (confirm(`Delete “${p.title}” from the library?`)) { await deletePiece(p.id); refreshLibrary(); }
  });
  actions.append(rename, del);

  li.append(thumb, title, meta, actions);
  const openIt = () => openPiece(p);
  li.addEventListener('click', openIt);
  li.addEventListener('keydown', e => { if (e.key === 'Enter') openIt(); });
  return li;
}

function button(label, glyph) {
  const b = document.createElement('button');
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.textContent = glyph;
  return b;
}

async function openPiece(p) {
  try {
    setStatus(`Opening “${p.title}”…`);
    await viewer.open(p);
    setStatus('');
  } catch (e) {
    console.error(e);
    setStatus(`Couldn't open “${p.title}”: ${e.message}`, true);
  }
}

// ---------- upload ----------
$('#upload-btn').addEventListener('click', () => fileInput.click());
$('#empty-upload').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { importFiles([...fileInput.files]); fileInput.value = ''; });

window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging'); });
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
window.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  if (viewer.isOpen) return;
  importFiles([...e.dataTransfer.files]);
});

async function importFiles(files) {
  if (!files.length) return;
  const problems = [];
  let added = 0;
  for (const [i, file] of files.entries()) {
    setStatus(`Importing ${i + 1} of ${files.length}: ${file.name}…`);
    const reader = readerForFile(file);
    if (!reader) { problems.push(`${file.name}: unsupported format`); continue; }
    let doc;
    try {
      doc = await reader.open(file);
      const thumb = await doc.thumbnail(360).catch(() => null);
      await addPiece({
        title: titleFromName(file.name),
        readerId: reader.id,
        blob: file,
        pageCount: doc.pageCount,
        thumb,
      });
      added++;
    } catch (e) {
      console.error(e);
      problems.push(`${file.name}: ${e.message || 'could not be read'}`);
    } finally {
      doc?.destroy();
    }
  }
  requestPersistence();
  await refreshLibrary();
  if (problems.length) setStatus(`Added ${added}. Problems — ${problems.join('; ')}`, true);
  else setStatus(`Added ${added} piece${added === 1 ? '' : 's'}.`);
  setTimeout(() => { if (!problems.length) setStatus(''); }, 3000);
}

function titleFromName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name;
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !text;
}

refreshLibrary();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
})();
