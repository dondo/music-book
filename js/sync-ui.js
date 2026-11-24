(function () {
'use strict';
// The sync dialog (opened by the cloud button in the library header): set up with a name and a generated passphrase, connect another
// device to existing data, see the state, sync now, disconnect. The engine is in sync.js.
const Sync = MB.Sync;
const btn = document.getElementById('sync-btn'), dlg = document.getElementById('sync-dialog'), body = dlg.querySelector('.settings-body');
const dot = btn.querySelector('.sync-dot');
let statusEl = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function button(label, fn, cls) { const b = el('button', cls || '', label); b.type = 'button'; b.addEventListener('click', fn); return b; }
function actions(...bs) { const r = el('div', 'sync-actions'); r.append(...bs); return r; }
function row(...n) { const r = el('div', 'row'); r.append(...n); return r; }
function field(label, hint) {
  const w = el('label', 'sync-field'), i = document.createElement('input');
  i.type = 'text'; i.autocomplete = 'off'; i.spellcheck = false; i.setAttribute('autocapitalize', 'off');
  w.append(el('span', '', label), i); if (hint) w.append(el('small', '', hint));
  return { wrap: w, input: i };
}
function show(...nodes) { body.replaceChildren(...nodes); statusEl = el('p', 'sync-status'); statusEl.setAttribute('aria-live', 'polite'); body.append(statusEl); }
function say(t, err) { if (statusEl) { statusEl.textContent = t || ''; statusEl.classList.toggle('err', !!err); } }
function when(t) {
  if (!t) return 'not yet';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : new Date(t).toLocaleDateString();
}

// ---- the header button ----
function paintButton() {
  const S = Sync.state;
  dot.hidden = !Sync.signedIn;
  dot.className = 'sync-dot' + (S.busy ? ' busy' : S.error ? ' err' : '');
  btn.title = !Sync.signedIn ? 'Sync across devices' : S.busy ? (S.text || 'Syncing…') : S.error ? 'Sync problem: ' + S.error : 'Sync is on (last synced ' + when(S.last) + ')';
}
Sync.onState(() => { paintButton(); if (dlg.open && view === 'home') { if (!Sync.signedIn || !dlg.dataset.signed || (dlg.dataset.signed === '1') !== Sync.signedIn) home(); else paintHome(); } });

// ---- screens ----
let view = 'home';
function home() {
  view = 'home';
  dlg.dataset.signed = Sync.signedIn ? '1' : '';
  if (Sync.signedIn) {
    const c = Sync.state.creds;
    let shown = false;
    const pw = el('code', 'sync-secret', '•••••••••');
    const tog = button('Show', () => { shown = !shown; pw.textContent = shown ? c.pass : '•••••••••'; tog.textContent = shown ? 'Hide' : 'Show'; });
    show(
      el('p', '', 'Your library and your markings (including the score files) are kept in sync with your other devices.'),
      row(el('span', 'sync-k', 'Name'), el('code', 'sync-secret', c.name)),
      row(el('span', 'sync-k', 'Passphrase'), pw, tog),
      el('p', 'sync-muted sync-last', ''),
      actions(button('Sync now', () => Sync.syncNow(), 'primary'), button('Disconnect this device', disconnect), button('Close', close)),
    );
    paintHome();
    return;
  }
  show(
    el('p', '', 'Everything in Music Book is stored in this browser, on this device only. To use your library on another device (or keep a backup), you can store it, encrypted, in the cloud: your music, folders, their order and everything you have drawn on a score.'),
    el('p', 'sync-muted', 'It is encrypted on this device with a key made from your name and passphrase; nobody else can read it, and it is not shared with the Music Theory app.'),
    actions(button('Set up sync', createName, 'primary'), button('Connect to existing sync data', connect), button('Close', close)),
  );
}
function paintHome() {                                      // the live part: last synced / syncing / problem
  const S = Sync.state, last = body.querySelector('.sync-last');
  if (!last) return;
  last.textContent = S.busy ? (S.text || 'Syncing…') : 'Last synced: ' + when(S.last);
  say(S.error, true);
  const now = body.querySelector('.sync-actions .primary'); if (now) now.disabled = !!S.busy;
}
function disconnect() {
  show(
    el('h3', '', 'Disconnect this device?'),
    el('p', '', 'This device stops syncing and forgets your name and passphrase. Your library here stays as it is, and what is already stored stays there; you can connect again with the same name and passphrase.'),
    actions(button('Disconnect', async () => { await Sync.disconnect(); home(); }, 'primary'), button('Cancel', home)),
  );
}

// setting up: a name, then a passphrase chosen for you
function createName(prefill) {
  view = 'create';
  const f = field('Your name for this account', 'At least ' + Sync.NAME_MIN + ' characters. Pick something memorable but unpredictable!');
  if (typeof prefill === 'string') f.input.value = prefill;
  const go = button('Choose a passphrase', () => {
    if (!Sync.validName(f.input.value)) { say('The name needs at least ' + Sync.NAME_MIN + ' characters (up to ' + Sync.NAME_MAX + ').', true); return; }
    reroll(f.input.value);
  }, 'primary');
  f.input.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); });
  show(f.wrap, actions(go, button('Back', home)));
  f.input.focus();
}
async function reroll(name) {
  show(el('p', '', 'Choosing a passphrase…'));
  try { review(await Sync.newAccount(name)); } catch (e) { createName(name); say(e.message, true); }
}
function createBtn(acct) {
  const b = button('Create and upload', async () => {
    b.disabled = true; say('Uploading…');
    await Sync.connect(acct.name, acct.pass);
    if (Sync.state.error) { say(Sync.state.error, true); b.disabled = false; return; }
    home();
  }, 'primary');
  return b;
}
function review(acct) {
  const note = el('div', 'sync-note');
  note.append(el('strong', '', 'Keep these safe'));
  note.append(el('p', '', 'The name and passphrase together identify your data and unlock it, which makes it easy to use on a new device. They can’t be changed or recovered: if you lose either one, the stored data is gone for good. Write them down somewhere you won’t lose them.'));
  show(el('h3', '', 'Your sync name and passphrase'), note,
    row(el('span', 'sync-k', 'Name'), el('code', 'sync-secret', acct.name)),
    row(el('span', 'sync-k', 'Passphrase'), el('code', 'sync-secret', acct.pass)),
    actions(createBtn(acct), button('Choose another passphrase', () => reroll(acct.name)), button('Cancel', home)));
}

// connecting this device to existing data
function connect() {
  view = 'connect';
  const n = field('Name'), p = field('Passphrase', 'Two words joined by a dash.'), offer = el('div', 'sync-actions');
  const go = button('Connect', async () => {
    offer.replaceChildren(); say('Checking…');
    try {
      if (!Sync.validName(n.input.value) || !Sync.validPass(p.input.value)) {
        say('A name has at least ' + Sync.NAME_MIN + ' characters, and a passphrase is two words of 4 to 6 letters joined by a dash.', true); return;
      }
      go.disabled = true;
      const d = await Sync.derive(n.input.value, p.input.value);
      if (!(await Sync.exists(d))) {
        say('No stored data for that name and passphrase. Want to create it?'); go.disabled = false;
        offer.replaceChildren(createBtn({ name: Sync.norm(n.input.value), pass: Sync.norm(p.input.value) })); return;
      }
      say('Connecting…');
      await Sync.connect(n.input.value, p.input.value);
      if (Sync.state.error) { say(Sync.state.error, true); go.disabled = false; return; }
      home();
    } catch (e) { say(e.message, true); go.disabled = false; }
  }, 'primary');
  [n.input, p.input].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') go.click(); }));
  show(el('p', 'sync-muted', 'This device’s library is merged with what is stored: music and markings from both end up on both.'), n.wrap, p.wrap, actions(go, button('Back', home)));
  body.append(offer);
  [n.input, p.input].forEach(i => i.addEventListener('input', () => offer.replaceChildren()));
  n.input.focus();
}

const close = () => dlg.close();
btn.addEventListener('click', () => { home(); dlg.showModal(); });
dlg.querySelector('.settings-close').addEventListener('click', close);
paintButton();
})();
