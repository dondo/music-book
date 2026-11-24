(function () {
'use strict';
// Annotations: fingerings, highlights, added notes and an eraser, drawn over the music.
//
// Everything is stored in PAGE units (the same units as the layout), per stored file, so markings stay
// put when you zoom, hide headers, or the screens are re-packed. The original file is never changed.
//
// Items (all have id and p = page number):
//   { t:'fing',  x, y, s, d }              fingering text s, centred at x,y; d = staff spacing it was sized from
//   { t:'hl',    x0, y0, x1, y1, c, gid }  translucent highlight rectangle (one per page it crosses; gid ties them)
//   { t:'note',  x, y, d }                 filled notehead, centred at x,y
//   { t:'erase', pts:[[x,y]...], r }       eraser stroke: white discs of radius r; the staff lines are redrawn over them
//
// The Move tool can drag, nudge and delete every kind of item. Moving an erase stroke moves the patch (not the music under it); deleting it brings the erased music back.
//
// Layers are drawn in a fixed order (erase, highlights, notes, fingerings) whatever order they were made in,
// so erasing a note under a highlight leaves the highlight intact.

const COLORS = [['Yellow', '#ffe14d'], ['Green', '#7be08a'], ['Pink', '#ff8fc2'], ['Blue', '#7cc4ff'], ['Orange', '#ffb259']];
const ERASER = [{ label: 'S', r: 0.45, title: 'Small: fits between two staff lines' }, { label: 'M', r: 0.8, title: 'Medium' }, { label: 'L', r: 1.4, title: 'Large' }];
const TOOL_KEYS = { f: 'fing', h: 'hl', n: 'note', e: 'erase', m: 'move' };
const FING_COLOR = '#1d4ed8';
const FING_SIZE = 1.8;                      // font size, in staff spaces
const NOTE = { rx: 0.62, ry: 0.46, rot: -0.38 };   // notehead half-axes in staff spaces, tilt in radians
const uid = () => crypto.randomUUID();

// ---------- staff helpers ----------
const stavesOn = (layout, p) => (layout.staves || []).filter(s => s.p === p);

function typicalD(layout, p) {
  const on = stavesOn(layout, p);
  const all = on.length ? on : (layout.staves || []);
  if (!all.length) return (layout.pages[p - 1]?.h || 800) / 90;
  const ds = all.map(s => s.d).sort((a, b) => a - b);
  return ds[ds.length >> 1];
}

// The staff nearest to y on page p (within a few staff spaces), or null.
function staffAt(layout, p, y) {
  let best = null, bd = Infinity;
  for (const s of stavesOn(layout, p)) {
    const bottom = s.top + (s.n - 1) * s.d;
    const dist = y < s.top ? s.top - y : (y > bottom ? y - bottom : 0);
    if (dist < bd) { bd = dist; best = s; }
  }
  return best && bd <= 4 * best.d ? best : null;
}

const dAt = (layout, p, y) => (staffAt(layout, p, y) || { d: typicalD(layout, p) }).d;

// Snap y to the nearest line or space of its staff (half-spaces), so an added note sits on the staff.
function snapNote(layout, p, y) {
  const s = staffAt(layout, p, y);
  if (!s) return { y, d: typicalD(layout, p) };
  return { y: s.top + Math.round((y - s.top) / (s.d / 2)) * (s.d / 2), d: s.d };
}

function fingBox(it) {
  const fs = FING_SIZE * it.d;
  const w = Math.max(it.s.length * 0.62 * fs, fs * 0.8) + 0.3 * fs, h = fs * 1.1;
  return { x0: it.x - w / 2, x1: it.x + w / 2, y0: it.y - h / 2, y1: it.y + h / 2 };
}
const circleHitsBox = (px, py, r, b) => {
  const cx = Math.min(Math.max(px, b.x0), b.x1), cy = Math.min(Math.max(py, b.y0), b.y1);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
};

// ---------- drawing ----------
// geom = { blocks:[{ p, y0, y1, top, h }], x0, S, dpr }; top/h are device pixels on the canvas, S = device px per page unit.
function draw(ctx, geom, items, layout, base) {
  if (!items.length) return;
  const S = geom.S;
  const X = x => (x - geom.x0) * S;
  // pass 1: erase strokes and highlights, clipped to their own block
  for (const b of geom.blocks) {
    const mine = items.filter(i => i.p === b.p && (i.t === 'erase' || i.t === 'hl'));
    if (!mine.length) continue;
    const Y = y => b.top + (y - b.y0) * S;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, b.top, ctx.canvas.width, b.h); ctx.clip();
    const staves = stavesOn(layout, b.p);
    for (const it of mine) if (it.t === 'erase') {
      for (const [px, py] of it.pts) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(X(px), Y(py), it.r * S, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#000';                       // put back the staff lines the disc covered
        for (const st of staves) for (let k = 0; k < st.n; k++) {
          const ly = st.top + k * st.d, dy = ly - py;
          if (Math.abs(dy) >= it.r) continue;
          const half = Math.sqrt(it.r * it.r - dy * dy);
          const xa = Math.max(px - half, st.x0), xb = Math.min(px + half, st.x1);
          if (xb > xa) { const th = Math.max(st.th * S, 1); ctx.fillRect(X(xa), Y(ly) - th / 2, (xb - xa) * S, th); }
        }
      }
    }
    if (base && mine.some(i => i.t === 'erase')) {   // the eraser takes notes only: put barlines and the clef/key/time signature back
      ctx.beginPath();
      for (const st of staves) {
        const d = st.d;
        for (const [bx0, bx1, by1] of st.bars || []) ctx.rect(X(bx0 - 0.2 * d), Y(st.top - 0.15 * d), (bx1 - bx0 + 0.4 * d) * S, (by1 - st.top + 0.3 * d) * S);
        if (st.prefix != null) ctx.rect(X(st.x0), Y(st.top - 3.5 * d), (st.prefix - st.x0) * S, (st.n * d + 7 * d) * S);
      }
      ctx.save(); ctx.clip(); ctx.drawImage(base, 0, 0); ctx.restore();
    }
    ctx.globalCompositeOperation = 'multiply';       // like a real highlighter: music stays black
    for (const it of mine) if (it.t === 'hl') {
      ctx.globalAlpha = 0.8; ctx.fillStyle = it.c;
      ctx.fillRect(X(it.x0), Y(it.y0), (it.x1 - it.x0) * S, (it.y1 - it.y0) * S);
    }
    ctx.restore();
  }
  // pass 2: notes and fingerings, not clipped, so one sitting right at the boundary between two systems is drawn whole
  const ownBlock = it => {                                   // each item is drawn once, in the block it sits in (or the nearest one)
    let best = null, bd = Infinity;
    for (const b of geom.blocks) {
      if (b.p !== it.p) continue;
      const d = it.y < b.y0 ? b.y0 - it.y : (it.y > b.y1 ? it.y - b.y1 : 0);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  };
  for (const b of geom.blocks) {
    const mine = items.filter(i => (i.t === 'note' || i.t === 'fing') && i.p === b.p && ownBlock(i) === b);
    if (!mine.length) continue;
    const Y = y => b.top + (y - b.y0) * S;
    ctx.fillStyle = '#000';
    for (const it of mine) if (it.t === 'note') {
      ctx.save(); ctx.translate(X(it.x), Y(it.y)); ctx.rotate(NOTE.rot);
      ctx.beginPath(); ctx.ellipse(0, 0, NOTE.rx * it.d * S, NOTE.ry * it.d * S, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    for (const it of mine) if (it.t === 'fing') {
      const fs = FING_SIZE * it.d * S;
      ctx.font = `700 ${fs}px ui-sans-serif, system-ui, Arial, sans-serif`;
      ctx.lineWidth = fs * 0.24; ctx.strokeStyle = '#fff';
      ctx.strokeText(it.s, X(it.x), Y(it.y));        // white halo keeps it legible over staff lines
      ctx.fillStyle = FING_COLOR; ctx.fillText(it.s, X(it.x), Y(it.y));
    }
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
}

// ---------- the store for one file ----------
class Annotations {
  constructor(layout) { this.layout = layout; this.items = []; this.undoStack = []; this.fileId = null; this.timer = null; }

  async load(fileId) {
    this.fileId = fileId;
    const saved = await MB.getAnnotations(fileId);
    this.items = saved?.items || [];
    this.undoStack = [];
  }

  // op = { add:[items], del:[items] }; applied by the caller, recorded here for undo and saving
  commit(op) {
    if (!op.add.length && !op.del.length) return;
    this.undoStack.push(op);
    this._schedule();
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return false;
    const gone = new Set(op.add.map(i => i.id));
    this.items = this.items.filter(i => !gone.has(i.id)).concat(op.del);
    this._schedule();
    return true;
  }

  _schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush(), 400); }

  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.fileId) return;
    try { await MB.putAnnotations(this.fileId, { v: 1, items: this.items }); } catch (e) { console.warn('Could not save annotations', e); }
  }
}

// ---------- the tools and their UI ----------
// Toolbar icons: 24x24, drawn in the button's text colour. The bar carries no text; explanations live in tooltips.
const ICON = (body) => `<svg class="ic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  fing: ICON('<path d="M9.5 3.5 7.5 20.5M16.5 3.5 14.5 20.5M4 9h16.5M3.5 15.5H20" stroke-width="2.1"/>'),
  hl: ICON('<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="currentColor" fill-opacity=".32"/>'),
  note: ICON('<path d="M1 4h22M1 8.5h22M1 13h22M1 17.5h22M1 22h22" stroke-width="1.1" opacity=".6"/><ellipse cx="12" cy="15.2" rx="6.6" ry="4.9" transform="rotate(-22 12 15.2)" fill="currentColor" stroke="none"/>'),
  erase: ICON('<path d="m9 20-5.2-5.2a1.6 1.6 0 0 1 0-2.3L13 3.3a1.6 1.6 0 0 1 2.3 0l5.4 5.4a1.6 1.6 0 0 1 0 2.3L12.5 19.2" /><path d="M7 11.5 13.5 18" /><path d="M9 20h11" />'),
  move: ICON('<path d="M22 14a8 8 0 0 1-8 8"/><path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"/><path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'),
  close: ICON('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'),
  undo: ICON('<path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />'),
  done: ICON('<path d="m5 12.5 4.5 4.5L19 7.5" />'),
  del: ICON('<path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.4h7a1.5 1.5 0 0 0 1.5-1.4L18 7" /><path d="M9 7V4.5h6V7" />'),
  pencil: ICON('<path d="M4 20l1-4.6L16.2 4.2a2.1 2.1 0 0 1 3 0l.6.6a2.1 2.1 0 0 1 0 3L8.6 19z"/><path d="m14 6.5 3.5 3.5M4 20l4.6-1"/>'),
  expand: ICON('<path d="M8.5 5.5v13l8-6.5z" fill="currentColor" stroke-width="1.2"/>'),      /* a plain triangle: points right to expand, flips to point left to collapse */
  left: ICON('<path d="M15 5 8 12l7 7"/>'), right: ICON('<path d="m9 5 7 7-7 7"/>'), up: ICON('<path d="m5 15 7-7 7 7"/>'), down: ICON('<path d="m5 9 7 7 7-7"/>'),
};
const DOTS = [3, 5.2, 8].map(r => ICON(`<circle cx="12" cy="12" r="${r}" fill="currentColor" stroke="none"/>`));   // eraser sizes
// Where the bar is docked: a screen with a thick bar on the docked edge.
const DOCKS = ['bottom', 'left', 'top', 'right'];
const DOCK_BAR = { bottom: 'x="6" y="15" width="12" height="3.2"', top: 'x="6" y="5.8" width="12" height="3.2"', left: 'x="5.8" y="6.5" width="3.2" height="11"', right: 'x="15" y="6.5" width="3.2" height="11"' };
const DOCK_NAMES = { bottom: 'Bottom edge', left: 'Left edge', top: 'Top edge', right: 'Right edge' };
const LBL = t => `<span class="lbl">${t}</span>`;
const dockIcon = (d) => ICON(`<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><rect ${DOCK_BAR[d]} rx="1" fill="currentColor" stroke="none"/>`);

class Annotator {
  constructor(viewer) {
    this.v = viewer;
    this.on = false;
    this.tool = 'fing';
    this.color = COLORS[0][1];
    this.size = 1;
    try {                                                  // the toolbar re-opens just as it was left: tool, colour, eraser size
      const s = JSON.parse(localStorage.getItem('mb-ann-state') || '{}');
      if (Object.values(TOOL_KEYS).includes(s.tool)) this.tool = s.tool;
      if (COLORS.some(c => c[1] === s.color)) this.color = s.color;
      if ([0, 1, 2].includes(s.size)) this.size = s.size;
    } catch {}
    this.anns = null;
    this.st = null;                  // gesture in progress
    this.pending = null;             // fingering being typed
    this.sel = null;                 // Move tool: selected items (a highlight that spans pages = several)
    this.nudgeOp = null;             // undo entry that consecutive nudges of one selection share
    this.hold = null;                // auto-repeat timers for the nudge buttons
    this._build();
  }

  get items() { return this.anns.items; }

  _build() {
    const root = this.v.root;
    const el = (html) => { const t = document.createElement('div'); t.innerHTML = html.trim(); return t.firstChild; };
    this.layer = el('<div class="ann-layer" hidden><canvas></canvas></div>');
    this.hint = this.layer.firstChild;
    this.bar = el(`<div class="ann-bar mode-collapsed" hidden>
      <div class="ann-group ann-pencil"><button type="button" class="ann-pencil-btn" aria-label="Annotate"><span class="pen">${ICONS.pencil}</span><span class="tri">${ICONS.expand}</span></button></div>
      <div class="ann-group ann-tools">
        <button type="button" data-tool="fing" title="(F) Fingering: tap, then type 1–5, / or -" aria-label="Fingering">${ICONS.fing}${LBL('Fingering')}</button>
        <button type="button" data-tool="hl" title="(H) Highlight: drag a box (tap a highlight to remove it)" aria-label="Highlight">${ICONS.hl}${LBL('Highlight')}</button>
        <div class="ann-sub ann-colors">${COLORS.map(([n, c]) => `<button type="button" class="sw" data-color="${c}" title="${n}" style="background:${c}"></button>`).join('')}</div>
        <button type="button" data-tool="note" title="(N) Add a note: tap on the staff" aria-label="Note">${ICONS.note}${LBL('Note')}</button>
        <button type="button" data-tool="erase" title="(E) Erase: drag over music (staff lines are kept)" aria-label="Erase">${ICONS.erase}${LBL('Erase')}</button>
        <div class="ann-sub ann-sizes">${ERASER.map((e, i) => `<button type="button" data-size="${i}" title="${e.title}" aria-label="${e.title}">${DOTS[i]}</button>`).join('')}</div>
        <button type="button" data-tool="move" title="(M) Move: drag an annotation, or tap to select it (then arrow keys or the arrows nudge it, Delete removes it)" aria-label="Move">${ICONS.move}${LBL('Move')}</button>
      </div>
      <div class="ann-group ann-nudge" hidden>
        <button type="button" class="ann-del" title="Delete ( Delete )" aria-label="Delete">${ICONS.del}${LBL('Delete')}</button>
      </div>
      <div class="ann-group">
        <button type="button" class="ann-move" aria-label="Toolbar position" aria-haspopup="menu"></button>
        <button type="button" class="ann-undo" title="Undo ( ⌘Z )" aria-label="Undo">${ICONS.undo}${LBL('Undo')}</button>
        <button type="button" class="ann-close" title="Close the toolbar and stop annotating ( a / Esc )" aria-label="Close">${ICONS.close}${LBL('Close')}</button>
      </div>
    </div>`);
    this.pop = el(`<div class="ann-pop" hidden>
      <input type="text" inputmode="none" maxlength="8" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Fingering">
      ${['1', '2', '3', '4', '5', '/', '-'].map(k => `<button type="button" data-key="${k}">${k}</button>`).join('')}
      <button type="button" class="back" title="Delete the last digit" aria-label="Delete the last digit">⌫</button>
      <button type="button" class="del" title="Delete this fingering" aria-label="Delete this fingering" hidden>${ICONS.del}</button>
      <button type="button" class="ok" title="Add (Enter)">✓</button>
      <button type="button" class="no" title="Cancel (Esc)">✕</button>
    </div>`);
    this.menu = el('<div class="ann-dockmenu" role="menu" hidden></div>');
    this.nudgers = el(`<div class="ann-nudgers" hidden>${[['0,-1', 'up', 'Nudge up ( ↑ )'], ['0,1', 'down', 'Nudge down ( ↓ )'], ['-1,0', 'left', 'Nudge left ( ← )'], ['1,0', 'right', 'Nudge right ( → )']]
      .map(([d, k, t]) => `<button type="button" data-nudge="${d}" title="${t}" aria-label="${t}">${ICONS[k]}</button>`).join('')}</div>`);
    root.append(this.layer, this.bar, this.pop, this.menu, this.nudgers);
    this.input = this.pop.querySelector('input');

    try { const d = localStorage.getItem('mb-ann-dock'); this.dock = DOCKS.includes(d) ? d : 'bottom'; } catch { this.dock = 'bottom'; }
    this._setDock(this.dock);
    this.bar.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.tool) this._selectTool(b.dataset.tool);
      else if (b.dataset.nudge) { if (e.detail === 0) this._nudgeBy(b.dataset.nudge, e.shiftKey); }
      else if (b.classList.contains('ann-del')) this._deleteSel();
      else if (b.dataset.color) { this.color = b.dataset.color; this._saveState(); }
      else if (b.dataset.size) { this.size = +b.dataset.size; this._saveState(); }
      else if (b.classList.contains('ann-move')) this._toggleMenu();
      else if (b.classList.contains('ann-pencil-btn')) this._cyclePencil();
      else if (b.classList.contains('ann-close')) this.setOn(false);
      else if (b.classList.contains('ann-undo')) this.undo();
      this._refresh();
    });
    this.bar.addEventListener('pointerdown', e => {
      e.stopPropagation();
      const b = e.target.closest('[data-nudge]');
      if (!b || e.button > 0) return;
      this._stopHold();
      this._nudgeBy(b.dataset.nudge, e.shiftKey);                       // press once...
      this.hold = { t: setTimeout(() => { this.hold.i = setInterval(() => this._nudgeBy(b.dataset.nudge, e.shiftKey), 60); }, 380) };   // ...hold to repeat
    });
    const down = e => {
      e.stopPropagation();
      const b = e.target.closest('[data-nudge]');
      if (!b || e.button > 0) return;
      this._stopHold();
      this._nudgeBy(b.dataset.nudge, e.shiftKey);                       // press once...
      this.hold = { t: setTimeout(() => { this.hold.i = setInterval(() => this._nudgeBy(b.dataset.nudge, e.shiftKey), 60); }, 380) };   // ...hold to repeat
    };
    this.nudgers.addEventListener('pointerdown', down);
    this.nudgers.addEventListener('click', e => { const b = e.target.closest('[data-nudge]'); e.stopPropagation(); if (b && e.detail === 0) this._nudgeBy(b.dataset.nudge, e.shiftKey); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) { this.bar.addEventListener(ev, () => this._stopHold()); this.nudgers.addEventListener(ev, () => this._stopHold()); }

    this.menu.addEventListener('pointerdown', e => e.stopPropagation());
    this.menu.addEventListener('click', e => {
      const b = e.target.closest('[data-dock]');
      e.stopPropagation();
      if (b) { this._closeMenu(); this._setDock(b.dataset.dock); }
    });
    try { const m = localStorage.getItem('mb-ann-mode'); this.lastOpen = m === 'icons' ? 'icons' : 'words'; } catch { this.lastOpen = 'words'; }

    this.pop.addEventListener('mousedown', e => { if (e.target !== this.input) e.preventDefault(); });   // keep the field focused
    this.pop.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.key) { this.input.value = (this.input.value + b.dataset.key).slice(0, 8); this.input.focus(); }
      else if (b.classList.contains('back')) { this.input.value = this.input.value.slice(0, -1); this.input.focus(); }
      else if (b.classList.contains('del')) { this.input.value = ''; this._commitPending(); }          // nothing left to add: an existing fingering is removed
      else if (b.classList.contains('ok')) this._commitPending();
      else if (b.classList.contains('no')) this._closePop();
    });
    this.input.addEventListener('input', () => { this.input.value = this.input.value.replace(/[^0-9/\-]/g, ''); });
    this.input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this._commitPending(); }
      else if (e.key === 'Escape') { e.preventDefault(); this._closePop(); }
    });

    const L = this.layer;
    L.addEventListener('pointerdown', e => this._down(e));
    L.addEventListener('pointermove', e => this._move(e));
    L.addEventListener('pointerup', e => this._up(e));
    L.addEventListener('pointercancel', e => this._cancel(e));
    L.addEventListener('pointerleave', () => { if (!this.st) this._clearHint(); });
    window.addEventListener('resize', () => this._sizeHint());
  }

  // ----- lifecycle -----
  async attach(fileId, layout) {
    this.detach();
    this.anns = new Annotations(layout);
    this.layout = layout;
    await this.anns.load(fileId);
    this.rescue();
    this.bar.hidden = false;                               // the (collapsed) pencil is available whenever a piece is open
    this.v.root.classList.add('ann-avail');
  }

  // Sync brought in changes to the markings of the open file: take them up (unless something here is still unsaved).
  async reloadFrom(fileId) {
    if (!this.anns || this.anns.fileId !== fileId || this.anns.timer || this.st) return;
    await this.anns.load(fileId);
    this.sel = null; this.nudgeOp = null;
    this._paintSoon();
  }

  detach() {
    this.sel = null; this.nudgeOp = null;
    this.setOn(false);
    if (this.anns) this.anns.flush();
    this.anns = null;
    this.bar.hidden = true;
    this.v.root.classList.remove('ann-avail');
  }

  setOn(on, mode) {
    on = !!on && !!this.anns && !!this.v.geom;
    if (!on) { this._closePop(); this._cancel(); this.sel = null; this.nudgeOp = null; }
    this.on = on;
    this.layer.hidden = !on;
    if (!on) this.nudgers.hidden = true;
    this.v.root.classList.toggle('annotating', on);
    this._applyMode(on ? (mode || this.lastOpen || 'words') : 'collapsed');
    if (on) { this._sizeHint(); this._refresh(); }
    this._clearHint();
    this.v.onAnnotate?.();
  }

  // Esc: close the fingering box, else leave annotating. Returns true if it did something.
  escape() {
    if (!this.pop.hidden) { this._closePop(); return true; }
    if (!this.menu.hidden) { this._closeMenu(); return true; }
    if (this.sel) { this.sel = null; this._refresh(); this._clearHint(); return true; }
    if (this.on) { this.setOn(false); return true; }
    return false;
  }

  undo() {
    this.nudgeOp = null;
    if (!this.anns || !this.anns.undo()) return;
    this.v.paint();
  }

  // Dock the toolbar at the bottom, left, top or right edge (remembered between visits).
  _setDock(d) {
    this.dock = d;
    for (const k of DOCKS) this.bar.classList.toggle(k, k === d);
    const btn = this.bar.querySelector('.ann-move');
    btn.innerHTML = dockIcon(d) + LBL('Toolbar');
    btn.title = `Toolbar position: now at the ${d}. Click to choose another edge.`;
    for (const k of DOCKS) this.v.root.classList.toggle('ann-dock-' + k, k === d);
    try { localStorage.setItem('mb-ann-dock', d); } catch {}
    this.v.onAnnotate?.();
  }

  _selectTool(t) {
    this._commitPending();
    this.tool = t; this.sel = null; this.nudgeOp = null;
    this._clearHint();                                     // (wipes the selection outline Move drew)
    this._saveState();
    this._refresh();
  }
  _saveState() {
    try { localStorage.setItem('mb-ann-state', JSON.stringify({ tool: this.tool, color: this.color, size: this.size })); } catch {}
    this.v.onAnnotate?.();
  }

  // The toolbar's look (tool, colour, eraser size, edge, names or icons), for keeping across reloads where localStorage isn't available.
  snapshot() { return { tool: this.tool, color: this.color, size: this.size, dock: this.dock, mode: this.lastOpen }; }
  applySnapshot(s) {
    if (!s) return;
    if (Object.values(TOOL_KEYS).includes(s.tool)) this.tool = s.tool;
    if (COLORS.some(c => c[1] === s.color)) this.color = s.color;
    if ([0, 1, 2].includes(s.size)) this.size = s.size;
    if (s.mode === 'icons' || s.mode === 'words') this.lastOpen = s.mode;
    if (DOCKS.includes(s.dock)) this._setDock(s.dock);
    this._refresh();
  }

  _toggleMenu() {
    if (!this.menu.hidden) { this._closeMenu(); return; }
    this.menu.innerHTML = DOCKS.filter(d => d !== this.dock).map(d => `<button type="button" role="menuitem" data-dock="${d}">${dockIcon(d)}<span>${DOCK_NAMES[d]}</span></button>`).join('');
    this.menu.hidden = false;
    const rr = this.v.root.getBoundingClientRect(), br = this.bar.querySelector('.ann-move').getBoundingClientRect();
    const mw = this.menu.offsetWidth, mh = this.menu.offsetHeight, gap = 8;
    let l = br.left - rr.left + br.width / 2 - mw / 2, t = br.top - rr.top + br.height / 2 - mh / 2;
    if (this.dock === 'bottom') t = br.top - rr.top - mh - gap;
    else if (this.dock === 'top') t = br.bottom - rr.top + gap;
    else if (this.dock === 'left') l = br.right - rr.left + gap;
    else l = br.left - rr.left - mw - gap;
    this.menu.style.left = Math.max(4, Math.min(l, rr.width - mw - 4)) + 'px';
    this.menu.style.top = Math.max(4, Math.min(t, rr.height - mh - 4)) + 'px';
    this.bar.querySelector('.ann-move').setAttribute('aria-expanded', 'true');
    this._menuOut = e => {                                  // a click elsewhere only closes the menu (it doesn't also act on the music)
      if (this.menu.contains(e.target) || e.target.closest('.ann-move')) return;
      this._closeMenu();
      if (!this.bar.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
    };
    document.addEventListener('pointerdown', this._menuOut, true);
  }
  _closeMenu() {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.bar.querySelector('.ann-move')?.setAttribute('aria-expanded', 'false');
    if (this._menuOut) { document.removeEventListener('pointerdown', this._menuOut, true); this._menuOut = null; }
  }

  // The triangle opens the toolbar (with names); once open it only switches between names and icons-only (▸ expands, ◂ collapses). Close collapses it.
  _cyclePencil() {
    if (!this.anns || this.v.busy) return;
    if (!this.on) this.setOn(true);                        // re-opens in the state it was closed in
    else this._applyMode(this.mode === 'words' ? 'icons' : 'words');
  }
  _applyMode(m) {
    this.mode = m;
    for (const k of ['collapsed', 'words', 'icons']) this.bar.classList.toggle('mode-' + k, k === m);
    const p = this.bar.querySelector('.ann-pencil-btn');
    p.title = p.ariaLabel = m === 'collapsed' ? 'Open the annotation toolbar ( a )' : m === 'words' ? 'Hide the button names' : 'Show the button names';
    if (m !== 'collapsed') { this.lastOpen = m; try { localStorage.setItem('mb-ann-mode', m); } catch {} this.v.onAnnotate?.(); }
    this._closeMenu();
  }

  _refresh() {
    for (const b of this.bar.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === this.tool ? 'true' : 'false');
    for (const b of this.bar.querySelectorAll('[data-color]')) b.setAttribute('aria-pressed', b.dataset.color === this.color ? 'true' : 'false');
    for (const b of this.bar.querySelectorAll('[data-size]')) b.setAttribute('aria-pressed', +b.dataset.size === this.size ? 'true' : 'false');
    this.bar.querySelector('.ann-colors').hidden = this.tool !== 'hl';
    this.bar.querySelector('.ann-sizes').hidden = this.tool !== 'erase';
    this.bar.querySelector('.ann-undo').disabled = !this.anns?.undoStack.length;
    this.bar.querySelector('.ann-nudge').hidden = !(this.tool === 'move' && this.sel);
    this.layer.classList.toggle('move', this.tool === 'move');
    this.layer.classList.toggle('selected', !!this.sel);                    // Move cursor: pointing hand, then grab hand once something is selected
    this.layer.classList.toggle('dragging', !!(this.st && this.st.drag));
    this.layer.classList.toggle('fing', this.tool === 'fing');
    if (this.tool !== 'move' || !this.sel) this.nudgers.hidden = true;     // the arrows belong to Move with something selected
    if (this.on && this.hint.width) this._clearHint();                     // redraw the Move indicators right away
  }

  // ----- coordinates -----
  _point(e, near = false) {
    const g = this.v.geom, view = this.v.view;
    if (!g || !view) return null;
    const r = view.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const cs = g.S / g.dpr;                              // css px per page unit
    for (const b of g.blocks) {
      const top = b.top / g.dpr, h = b.h / g.dpr;
      if (cx >= 0 && cx <= r.width && cy >= top && cy < top + h) {
        return { b, p: b.p, x: g.x0 + cx / cs, y: b.y0 + (cy - top) / cs, cx, cy, clientX: e.clientX, clientY: e.clientY };
      }
    }
    if (near && g.blocks.length && r.width > 0) {          // pointer is off the music: use the nearest spot on it
      const at = this._atCss(cx, cy);
      return { ...at, clientX: e.clientX, clientY: e.clientY, near: true };
    }
    return null;
  }

  // A CSS position on the screen canvas -> page position, clamped onto the canvas. Systems are stacked with no gaps on
  // screen, so moving in screen space crosses from one system to the next smoothly.
  _atCss(cx, cy) {
    const g = this.v.geom, cs = g.S / g.dpr, W = this.v.view.getBoundingClientRect().width;
    const first = g.blocks[0], last = g.blocks[g.blocks.length - 1];
    const cxc = Math.min(Math.max(cx, 0), W);
    const cyc = Math.min(Math.max(cy, first.top / g.dpr), (last.top + last.h) / g.dpr - 1e-6);
    let b = g.blocks.find(k => cyc >= k.top / g.dpr && cyc < (k.top + k.h) / g.dpr) || last;
    const top = b.top / g.dpr;
    return { b, p: b.p, x: g.x0 + cxc / cs, y: b.y0 + (cyc - top) / cs, cx: cxc, cy: cyc };
  }

  // Where an item's centre is on the screen canvas (CSS px), or null if its page is not on this screen.
  _screenOf(it) {
    const g = this.v.geom, cs = g.S / g.dpr;
    it = this._ctr(it);
    const bl = g.blocks.filter(k => k.p === it.p);
    if (!bl.length) return null;
    const b = bl.find(k => it.y >= k.y0 && it.y <= k.y1)
      || bl.reduce((m, k) => Math.min(Math.abs(it.y - k.y0), Math.abs(it.y - k.y1)) < Math.min(Math.abs(it.y - m.y0), Math.abs(it.y - m.y1)) ? k : m);
    return { cx: (it.x - g.x0) * cs, cy: b.top / g.dpr + (Math.min(Math.max(it.y, b.y0), b.y1) - b.y0) * cs };
  }

  _opNew() { return { add: [], del: [] }; }

  // ----- gestures -----
  _down(e) {
    if (e.button > 0) return;
    e.preventDefault();
    this._commitPending();
    const pt = this._point(e);
    try { this.layer.setPointerCapture(e.pointerId); } catch {}
    this.nudgeOp = null;
    this.st = { id: e.pointerId, start: pt, last: pt, moved: false, op: this._opNew(), cur: null, drag: null };
    if (pt && this.tool === 'erase') this._eraseAt(pt);
    if (this.tool === 'move') this._grab(e, pt);
  }

  _move(e) {
    const pt = this._point(e);
    const st = this.st;
    if (!st || st.id !== e.pointerId) { this._showHint(e, pt); return; }
    if (st.start && pt && Math.hypot(pt.cx - st.start.cx, pt.cy - st.start.cy) > 6) st.moved = true;
    if (!st.start && pt) st.start = pt;
    if (pt) st.last = pt;
    if (this.tool === 'erase' && pt) this._eraseAt(pt);
    if (st.drag && st.moved) this._dragTo(e);
    this._showHint(e, pt);
  }

  _up(e) {
    const st = this.st;
    if (!st || st.id !== e.pointerId) return;
    this.st = null;
    const pt = this._point(e) || st.last;
    try { this.layer.releasePointerCapture(e.pointerId); } catch {}
    const tool = this.tool, A = this.anns, op = st.op;

    if (tool === 'fing') {
      if (pt && !st.moved) {
        const hit = this.anns.items.filter(i => i.t === 'fing' && i.p === pt.p && circleHitsBox(pt.x, pt.y, 0, fingBox(i))).pop();
        if (hit) { this._selectTool('move'); this.sel = [hit]; this._refresh(); }      // tapping a fingering that is already there selects it, ready to move or delete
        else this._openPop(pt);
      }
    } else if (tool === 'note') {
      if (pt) {
        const sn = snapNote(this.layout, pt.p, pt.y);
        const it = { id: uid(), t: 'note', p: pt.p, x: pt.x, y: sn.y, d: sn.d };
        this._place(it, pt.b);
        A.items.push(it); op.add.push(it);
      }
    } else if (tool === 'hl') {
      if (!st.moved) { if (pt) this._removeHighlightAt(pt, op); }
      else this._addHighlight(st.start, pt || st.last, op);
    } else if (tool === 'erase') {
      this._finishErase(st);
    } else if (tool === 'move') {
      const one = st.drag && !st.moved && st.drag.items.length === 1 && st.drag.items[0].t === 'fing' ? st.drag.items[0] : null;
      const dbl = one && this._tap && this._tap.id === one.id && Date.now() - this._tap.t < 450;
      this._tap = one && !dbl ? { id: one.id, t: Date.now() } : null;
      if (dbl && pt) { this._tap = null; this._openPop(pt); }                                  // double-tap a fingering: edit its number
      else if (st.drag && st.moved) { op.add = st.drag.items.slice(); op.del = st.drag.snaps; }   // same ids: undo puts the old copies back
      else if (!st.drag) this.sel = null;                                                   // tapped empty space
    }
    A.commit(op);
    this._refresh();
    this._clearHint();
    this.v.paint();
  }

  _cancel(e) {
    const st = this.st;
    if (!st) return;
    this.st = null;
    try { if (e) this.layer.releasePointerCapture(e.pointerId); } catch {}
    // roll back a half-finished erase stroke
    if (st.cur) this.anns.items = this.anns.items.filter(i => i !== st.cur);
    if (st.drag) {
      const cur = new Set(st.drag.items.map(i => i.id));
      this.anns.items = this.anns.items.filter(i => !cur.has(i.id)).concat(st.drag.snaps);
      this.sel = null;
    }
    for (const it of st.op.del) this.anns.items.push(it);
    this._clearHint();
    this.v.paint();
  }

  // ----- erase -----
  _eraseAt(pt) {
    const st = this.st, A = this.anns;
    const d = dAt(this.layout, pt.p, pt.y);
    const r = ERASER[this.size].r * d;
    if (!st.cur || st.cur.p !== pt.p) {
      if (st.cur) st.op.add.push(st.cur);
      st.cur = { id: uid(), t: 'erase', p: pt.p, pts: [], r };
      A.items.push(st.cur);
    }
    const last = st.cur.pts[st.cur.pts.length - 1];
    if (last && Math.hypot(pt.x - last[0], pt.y - last[1]) < 0.25 * st.cur.r) return;
    st.cur.pts.push([pt.x, pt.y]);
    // wipe away any note or fingering of mine under the eraser
    for (const it of A.items.filter(i => i.p === pt.p && (i.t === 'note' || i.t === 'fing'))) {
      const hit = it.t === 'note' ? Math.hypot(it.x - pt.x, it.y - pt.y) < st.cur.r + 0.6 * it.d
        : circleHitsBox(pt.x, pt.y, st.cur.r, fingBox(it));
      if (hit) { A.items = A.items.filter(i => i !== it); st.op.del.push(it); }
    }
    this._paintSoon();
  }

  _finishErase(st) {
    if (st.cur) st.op.add.push(st.cur);
    st.cur = null;
  }

  _paintSoon() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.v.paint(); });
  }

  // ----- highlight -----
  // A highlight is one screen rectangle, stored as one piece per system it covers.
  _hlPieces(rect, color, gid) {
    const g = this.v.geom, cs = g.S / g.dpr, out = [];
    for (const blk of g.blocks) {
      const top = blk.top / g.dpr, h = blk.h / g.dpr;
      const y0 = Math.max(rect.y0, top), y1 = Math.min(rect.y1, top + h);
      if (y1 - y0 < 1) continue;
      out.push({ id: uid(), t: 'hl', p: blk.p, gid, c: color,
        x0: g.x0 + rect.x0 / cs, x1: g.x0 + rect.x1 / cs, y0: blk.y0 + (y0 - top) / cs, y1: blk.y0 + (y1 - top) / cs });
    }
    return out;
  }

  _hlScreenRect(items) {
    const g = this.v.geom, cs = g.S / g.dpr;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const it of items) {
      const mid = (it.y0 + it.y1) / 2;
      const b = g.blocks.find(k => k.p === it.p && mid >= k.y0 && mid <= k.y1);
      if (!b) continue;
      const top = b.top / g.dpr;
      y0 = Math.min(y0, top + (Math.max(it.y0, b.y0) - b.y0) * cs); y1 = Math.max(y1, top + (Math.min(it.y1, b.y1) - b.y0) * cs);
      x0 = Math.min(x0, (it.x0 - g.x0) * cs); x1 = Math.max(x1, (it.x1 - g.x0) * cs);
    }
    return x1 < x0 ? null : { x0, x1, y0, y1 };
  }

  // Replace a highlight's pieces by the pieces of a moved rectangle (kept on the canvas). Returns the new pieces.
  _hlMoveTo(items, rect) {
    const A = this.anns, vr = this.v.view.getBoundingClientRect();
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    const nx = Math.min(Math.max(rect.x0, 0), Math.max(0, vr.width - w)), ny = Math.min(Math.max(rect.y0, 0), Math.max(0, vr.height - h));
    const pieces = this._hlPieces({ x0: nx, x1: nx + w, y0: ny, y1: ny + h }, items[0].c, items[0].gid);
    if (!pieces.length) return items;
    pieces.forEach((pc, k) => { if (items[k]) pc.id = items[k].id; });
    const gone = new Set(items.map(i => i.id));
    A.items = A.items.filter(i => !gone.has(i.id)).concat(pieces);
    return pieces;
  }

  _addHighlight(a, b, op) {
    if (!a || !b) return;
    const rect = { x0: Math.min(a.cx, b.cx), x1: Math.max(a.cx, b.cx), y0: Math.min(a.cy, b.cy), y1: Math.max(a.cy, b.cy) };
    for (const it of this._hlPieces(rect, this.color, uid())) { this.anns.items.push(it); op.add.push(it); }
  }

  _removeHighlightAt(pt, op) {
    const hit = this.anns.items.filter(i => i.t === 'hl' && i.p === pt.p && pt.x >= i.x0 && pt.x <= i.x1 && pt.y >= i.y0 && pt.y <= i.y1);
    if (!hit.length) return;
    const gids = new Set(hit.map(i => i.gid));
    const all = this.anns.items.filter(i => i.t === 'hl' && gids.has(i.gid));   // a box that spans pages goes as one
    this.anns.items = this.anns.items.filter(i => !all.includes(i));
    op.del.push(...all);
  }

  // ----- fingering -----
  _openPop(pt) {
    const hit = this.anns.items.filter(i => i.t === 'fing' && i.p === pt.p && circleHitsBox(pt.x, pt.y, 0, fingBox(i))).pop();
    this.pending = { pt, existing: hit || null };
    this.input.value = hit ? hit.s : '';
    this.pop.querySelector('.del').hidden = !hit;          // only a fingering that is already there can be deleted
    this.pop.hidden = false;
    const w = this.pop.offsetWidth || 330, h = this.pop.offsetHeight || 44;
    const left = Math.min(Math.max(8, pt.clientX - w / 2), window.innerWidth - w - 8);
    const top = pt.clientY + h + 24 > window.innerHeight ? pt.clientY - h - 18 : pt.clientY + 18;
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${Math.max(8, top)}px`;
    this.input.focus();
    this.input.select();
    this._clearHint();                                     // draws the box where the number will go
  }

  _closePop() {
    this.pending = null;
    if (!this.pop.hidden) { this.pop.hidden = true; this.input.blur(); this._clearHint(); }
  }

  _commitPending() {
    const pd = this.pending;
    if (!pd || this.pop.hidden) { this._closePop(); return; }
    const s = this.input.value.replace(/[^0-9/\-]/g, '').slice(0, 8);
    const A = this.anns, op = this._opNew();
    if (pd.existing) { A.items = A.items.filter(i => i !== pd.existing); op.del.push(pd.existing); }
    if (s) {
      const it = { id: uid(), t: 'fing', p: pd.pt.p, x: pd.existing ? pd.existing.x : pd.pt.x, y: pd.existing ? pd.existing.y : pd.pt.y, s,
        d: pd.existing ? pd.existing.d : dAt(this.layout, pd.pt.p, pd.pt.y) };
      const blk = this.v.geom.blocks.find(k => k === pd.pt.b) || this._blockFor(it);
      if (blk) this._place(it, blk);
      A.items.push(it); op.add.push(it);
    }
    this._closePop();
    A.commit(op);
    this._refresh();
    this.v.paint();
  }

  // ----- hints (cursor previews) -----
  _sizeHint() {
    const r = this.layer.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.hint.width = Math.round(r.width * dpr); this.hint.height = Math.round(r.height * dpr);
  }
  _clearHint() {
    const c = this.hint.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, this.hint.width, this.hint.height);
    if (this.on && this.tool === 'move' && this.anns && this.v.geom) this._drawMove(c);
    if (this.pending && !this.pop.hidden && this.v.geom && this.v.view) {          // the fingering box stays where it was clicked while the number is chosen
      const lr = this.layer.getBoundingClientRect(), vr = this.v.view.getBoundingClientRect(), pt = this.pending.pt;
      c.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      this._drawFingBox(c, pt, vr.left - lr.left + pt.cx, vr.top - lr.top + pt.cy);
    }
  }
  _drawFingBox(c, pt, X, Y) {                              // a box the size of one fingering character, centred on X, Y
    const cs = this.v.scale, d = dAt(this.layout, pt.p, pt.y), bx = fingBox({ x: 0, y: 0, s: '1', d });
    const w = (bx.x1 - bx.x0) * cs, h = (bx.y1 - bx.y0) * cs;
    c.fillStyle = 'rgba(29,78,216,.10)'; c.fillRect(X - w / 2, Y - h / 2, w, h);
    c.lineWidth = 1.5; c.strokeStyle = 'rgba(29,78,216,.9)'; c.strokeRect(X - w / 2, Y - h / 2, w, h);
  }
  overlay() { this._clearHint(); }                       // called after every repaint

  // ----- keeping annotations on the music -----
  // Blank space between systems is dropped from the screen, so a spot there would be invisible. Notes and fingerings
  // are therefore kept fully inside a block (and inside the music's width); a note keeps snapping to the staff grid.
  _half(it) {
    if (it.t === 'fing') { const b = fingBox(it); return { w: (b.x1 - b.x0) / 2, h: (b.y1 - b.y0) / 2 }; }
    return { w: 0.7 * it.d, h: 0.55 * it.d };
  }

  _place(it, blk) {
    const L = this.layout, hs = this._half(it);
    const xlo = L.x0 + hs.w, xhi = L.x1 - hs.w;
    it.x = xhi >= xlo ? Math.min(Math.max(it.x, xlo), xhi) : (L.x0 + L.x1) / 2;
    const lo = blk.y0, hi = blk.y1;                          // only the centre must be inside the block, so an item can sit on the boundary
    const s = it.t === 'note' ? staffAt(L, it.p, it.y) : null;
    if (s) {
      const half = s.d / 2;
      const kmin = Math.ceil((lo - s.top) / half), kmax = Math.floor((hi - s.top) / half);
      const k = Math.round((it.y - s.top) / half);
      it.y = kmin <= kmax ? s.top + Math.min(Math.max(k, kmin), kmax) * half : (lo + hi) / 2;
      it.d = s.d;
    } else it.y = Math.min(Math.max(it.y, lo), hi);
  }

  // The block of the current screen that an item belongs to (the one holding it, else the nearest on its page).
  _blockFor(it) {
    const bl = (this.v.geom?.blocks || []).filter(k => k.p === it.p);
    return bl.find(k => it.y >= k.y0 && it.y <= k.y1) || bl.reduce((m, k) => {
      const d = Math.min(Math.abs(it.y - k.y0), Math.abs(it.y - k.y1));
      return !m || d < m.d ? { ...k, d } : m;
    }, null);
  }

  // Pull anything that ended up in a dropped gap (or crossing a block edge) back onto the music. Runs when a file opens.
  rescue() {
    const L = this.layout;
    let changed = false;
    for (const it of this.anns.items) {
      if (it.t !== 'fing' && it.t !== 'note' && it.t !== 'hl') continue;
      const bl = L.blocks.filter(k => k.p === it.p);
      if (!bl.length) continue;
      if (it.t === 'hl') {
        const cy = (it.y0 + it.y1) / 2;
        if (bl.some(k => cy >= k.y0 && cy <= k.y1)) continue;
        const k = bl.reduce((m, q) => Math.min(Math.abs(cy - q.y0), Math.abs(cy - q.y1)) < Math.min(Math.abs(cy - m.y0), Math.abs(cy - m.y1)) ? q : m);
        const to = Math.min(Math.max(cy, k.y0), k.y1), dy = to - cy;
        it.y0 += dy; it.y1 += dy; changed = true;
        continue;
      }
      const hs = this._half(it);
      const inBlk = bl.find(k => it.y >= k.y0 - 1e-6 && it.y <= k.y1 + 1e-6);
      if (inBlk && it.x - hs.w >= L.x0 - 1e-6 && it.x + hs.w <= L.x1 + 1e-6) continue;
      const k = bl.find(q => it.y >= q.y0 && it.y <= q.y1) || bl.reduce((m, q) => Math.min(Math.abs(it.y - q.y0), Math.abs(it.y - q.y1)) < Math.min(Math.abs(it.y - m.y0), Math.abs(it.y - m.y1)) ? q : m);
      const before = [it.x, it.y];
      this._place(it, k);
      if (before[0] !== it.x || before[1] !== it.y) changed = true;
    }
    if (changed) this.anns._schedule();
  }

  // ----- Move tool -----
  _stopHold() { if (this.hold) { clearTimeout(this.hold.t); clearInterval(this.hold.i); this.hold = null; this._placeNudgers(); } }

  // Bounding box of an item in page units.
  _boxOf(it) {
    if (it.t === 'fing') return fingBox(it);
    if (it.t === 'note') { const r = 0.95 * it.d; return { x0: it.x - r, x1: it.x + r, y0: it.y - r, y1: it.y + r }; }
    if (it.t === 'erase') {
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const q of it.pts) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
      return { x0: x0 - it.r, x1: x1 + it.r, y0: y0 - it.r, y1: y1 + it.r };
    }
    return { x0: it.x0, x1: it.x1, y0: it.y0, y1: it.y1 };
  }

  // Page point -> CSS point inside the annotation layer (null if that part of the page is not on screen).
  _toLayer(p, x, y) {
    const g = this.v.geom, vr = this.v.view.getBoundingClientRect(), lr = this.layer.getBoundingClientRect(), cs = g.S / g.dpr;
    const b = g.blocks.find(k => k.p === p && y >= k.y0 - 1e-6 && y <= k.y1 + 1e-6);
    if (!b) return null;
    return [vr.left - lr.left + (x - g.x0) * cs, vr.top - lr.top + b.top / g.dpr + (y - b.y0) * cs];
  }

  _movable() { return this.anns.items; }

  // An erase stroke has no single position: use the centre of its box. Moves replace `pts` (never edit it in place) so undo snapshots stay valid.
  _ctr(it) {
    if (it.t !== 'erase') return it;
    const b = this._boxOf(it);
    return { p: it.p, x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
  }
  _strokeTo(it, from, p, x, y) {                            // from = the stroke (or a snapshot) to translate so its centre lands on (x, y)
    const c = this._ctr(from), L = this.layout;
    const nx = Math.min(Math.max(x, L.x0), L.x1), dx = nx - c.x, dy = y - c.y;
    it.p = p;
    it.pts = from.pts.map(q => [q[0] + dx, q[1] + dy]);
  }

  // The frame drawn around a movable item, in layer CSS px (null if it is not on this screen).
  _frameOf(it) {
    const cs = this.v.scale, b = this._boxOf(it);
    const mid = this._toLayer(it.p, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);     // place from the centre, which is always on screen
    if (!mid) return null;
    const hw = (b.x1 - b.x0) / 2 * cs, hh = (b.y1 - b.y0) / 2 * cs, pad = 3;
    let x0 = mid[0] - hw - pad, y0 = mid[1] - hh - pad, x1 = mid[0] + hw + pad, y1 = mid[1] + hh + pad;
    if (it.t === 'note') {                                 // keep tiny notes easy to see and to grab
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, r = Math.max((x1 - x0) / 2, 11);
      x0 = mx - r; x1 = mx + r; y0 = my - r; y1 = my + r;
    }
    return { x0, y0, x1, y1 };
  }

  // The four nudge arrows sit around the four sides of the selected annotation.
  _placeNudgers() {
    const n = this.nudgers;
    const show = this.on && this.tool === 'move' && this.sel && !(this.st && this.st.drag && this.st.drag.moved);
    if (!show) { n.hidden = true; return; }
    if (this.hold && !n.hidden) return;                    // hold-to-repeat: keep the arrows still under the finger
    let u = null;
    for (const it of this.sel) { const f = this._frameOf(it); if (f) u = u ? { x0: Math.min(u.x0, f.x0), y0: Math.min(u.y0, f.y0), x1: Math.max(u.x1, f.x1), y1: Math.max(u.y1, f.y1) } : f; }
    if (!u) { n.hidden = true; return; }
    const lr = this.layer.getBoundingClientRect(), rr = this.v.root.getBoundingClientRect();
    const S = 34, gap = 7, W = rr.width, H = rr.height, ox = lr.left - rr.left, oy = lr.top - rr.top;
    const cx = ox + (u.x0 + u.x1) / 2, cy = oy + (u.y0 + u.y1) / 2;
    const pos = { '0,-1': [cx - S / 2, oy + u.y0 - gap - S], '0,1': [cx - S / 2, oy + u.y1 + gap],
      '-1,0': [ox + u.x0 - gap - S, cy - S / 2], '1,0': [ox + u.x1 + gap, cy - S / 2] };
    n.hidden = false;
    for (const b of n.children) {
      const [x, y] = pos[b.dataset.nudge];
      b.style.left = Math.max(4, Math.min(x, W - S - 4)) + 'px';
      b.style.top = Math.max(4, Math.min(y, H - S - 4)) + 'px';
    }
  }

  _drawMove(c) {
    const dpr = window.devicePixelRatio || 1, cs = this.v.scale;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.sel) {     // keep the selection pointing at live items (undo replaces objects)
      const live = this.sel.map(s => this.anns.items.find(i => i.id === s.id)).filter(Boolean);
      this.sel = live.length ? live : null;
    }
    this._placeNudgers();
    const selIds = new Set((this.sel || []).map(i => i.id));
    for (const sel of [false, true]) for (const it of this._movable()) {
      if (selIds.has(it.id) !== sel) continue;
      const fr = this._frameOf(it);
      if (!fr) continue;
      const { x0, y0, x1, y1 } = fr;
      c.lineWidth = sel ? 2.5 : 1.5;
      c.strokeStyle = sel ? '#00b7ff' : '#ff9f1a';
      c.setLineDash(sel ? [] : [5, 4]);
      c.beginPath();
      if (it.t === 'note') c.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, Math.PI * 2);
      else c.rect(x0, y0, x1 - x0, y1 - y0);
      c.stroke();
      c.setLineDash([]);
      // badge: a small "move" cross on the top-right corner
      const bx = x1, by = y0, br = 8;
      c.fillStyle = sel ? '#00b7ff' : '#ff9f1a';
      c.beginPath(); c.arc(bx, by, br, 0, Math.PI * 2); c.fill();
      c.strokeStyle = '#111'; c.lineWidth = 1.6; c.beginPath();
      c.moveTo(bx - 4.5, by); c.lineTo(bx + 4.5, by); c.moveTo(bx, by - 4.5); c.lineTo(bx, by + 4.5); c.stroke();
      if (sel) {
        c.fillStyle = '#00b7ff';
        for (const [hx, hy] of [[x0, y0], [x1, y1], [x0, y1]]) c.fillRect(hx - 3, hy - 3, 6, 6);
      }
    }
  }

  // The topmost movable item at a point. Fingerings and notes win over highlights underneath. A highlight that
  // was dragged across two pages is stored as two pieces and moves as one.
  _hit(pt) {
    const cs = this.v.scale, tol = 16 / cs;
    const on = this.anns.items.filter(i => i.p === pt.p);
    const last = f => { for (let k = on.length - 1; k >= 0; k--) if (f(on[k])) return on[k]; return null; };
    const it = last(i => i.t === 'fing' && circleHitsBox(pt.x, pt.y, tol * 0.6, fingBox(i)))
      || last(i => i.t === 'note' && Math.hypot(i.x - pt.x, i.y - pt.y) <= Math.max(0.95 * i.d, tol))
      || last(i => i.t === 'hl' && pt.x >= i.x0 && pt.x <= i.x1 && pt.y >= i.y0 && pt.y <= i.y1)
      || last(i => i.t === 'erase' && i.pts.some(q => Math.hypot(q[0] - pt.x, q[1] - pt.y) <= Math.max(i.r, tol * 0.6)));
    if (!it) return null;
    return it.t === 'hl' ? this.anns.items.filter(i => i.t === 'hl' && i.gid === it.gid) : [it];
  }

  _grab(e, pt) {
    const st = this.st;
    const hit = pt ? this._hit(pt) : null;
    if (!hit) { this.sel = null; this._refresh(); return; }
    this.sel = hit;
    const vr = this.v.view.getBoundingClientRect();
    const sx = e.clientX - vr.left, sy = e.clientY - vr.top;
    const scr = hit[0].t === 'hl' ? null : this._screenOf(hit[0]);
    st.drag = { items: hit, snaps: hit.map(i => ({ ...i, pts: i.pts ? i.pts.map(q => q.slice()) : undefined })), sx, sy,
      ox: scr ? scr.cx - sx : 0, oy: scr ? scr.cy - sy : 0,          // grab offset, in screen px
      rect0: hit[0].t === 'hl' ? this._hlScreenRect(hit) : null, moved: false };
    this._refresh();
    this._clearHint();
  }

  // Dragging works in screen space (where the systems are stacked with no gaps), so an item slides smoothly from one
  // system to the next instead of hanging at the boundary.
  _dragTo(e) {
    const d = this.st.drag, vr = this.v.view.getBoundingClientRect();
    const px = e.clientX - vr.left, py = e.clientY - vr.top;
    if (d.items[0].t === 'hl') {                             // highlights keep their size
      if (!d.rect0) return;
      const dx = px - d.sx, dy = py - d.sy, r = d.rect0;
      d.items = this._hlMoveTo(d.items, { x0: r.x0 + dx, x1: r.x1 + dx, y0: r.y0 + dy, y1: r.y1 + dy });
      this.sel = d.items;
    } else if (d.items[0].t === 'erase') {
      const at = this._atCss(px + d.ox, py + d.oy);
      this._strokeTo(d.items[0], d.snaps[0], at.p, at.x, Math.min(Math.max(at.y, at.b.y0), at.b.y1));
    } else {
      const it = d.items[0], at = this._atCss(px + d.ox, py + d.oy);
      it.p = at.p; it.x = at.x; it.y = at.y;
      if (it.t === 'note') { const sn = snapNote(this.layout, it.p, it.y); it.y = sn.y; it.d = sn.d; }   // stay on a line or space
      this._place(it, at.b);
    }
    this._paintSoon();
  }

  // dir = "dx,dy" in steps. One step = 1 screen pixel at this zoom (Shift: 5); a note's vertical step is half a staff space
  // so it stays on a line or space (Shift: a whole space).
  _nudgeBy(dir, big) {
    if (!this.sel || !this.anns) return;
    const [sx, sy] = dir.split(',').map(Number);
    const A = this.anns, cs = this.v.scale, px = big ? 5 : 1;               // px = screen pixels per step
    const key = this.sel[0].gid || this.sel[0].id;
    if (!this.nudgeOp || this.nudgeOp.key !== key) {                         // consecutive nudges = one undo step
      const op = { add: this.sel.slice(), del: this.sel.map(i => ({ ...i })) };
      A.undoStack.push(op);
      this.nudgeOp = { key, op };
    }
    if (this.sel[0].t === 'hl') {
      const r = this._hlScreenRect(this.sel);
      if (r) { this.sel = this._hlMoveTo(this.sel, { x0: r.x0 + sx * px, x1: r.x1 + sx * px, y0: r.y0 + sy * px, y1: r.y1 + sy * px }); this.nudgeOp.op.add = this.sel.slice(); }
    } else {
      for (const it of this.sel) {                                          // move in screen space so it can cross into the next system
        const s = this._screenOf(it);
        if (!s) continue;
        if (it.t === 'erase') {
          const at = this._atCss(s.cx + sx * px, s.cy + sy * px);
          this._strokeTo(it, it, at.p, at.x, Math.min(Math.max(at.y, at.b.y0), at.b.y1));
          continue;
        }
        const stepY = it.t === 'note' ? (big ? 1 : 0.5) * it.d * cs : px;   // a note steps by half a staff space (a whole one with Shift)
        // A note snaps to its grid, so one step can land back where it started (at the end of a block's grid, before the
        // next system). Keep widening the step until the item really moves in the asked direction.
        let at = null, next = null;
        for (let k = 1; k <= 40; k++) {
          at = this._atCss(s.cx + sx * px, s.cy + sy * stepY * k);
          next = { ...it, p: at.p, x: at.x, y: at.y };
          if (it.t === 'note' && sy) { const sn = snapNote(this.layout, next.p, next.y); next.y = sn.y; next.d = sn.d; }
          this._place(next, at.b);
          const ns = this._screenOf(next);
          if (!sy || (ns && (ns.cy - s.cy) * sy > 0.01) || at.cy <= 0 || at.cy >= this.v.view.getBoundingClientRect().height - 1) break;
        }
        it.p = next.p; it.x = next.x; it.y = next.y; it.d = next.d;
      }
    }
    A._schedule();
    this._refresh();
    this.v.paint();
  }

  _deleteSel() {
    if (!this.sel || !this.anns) return;
    const A = this.anns, gone = new Set(this.sel.map(i => i.id));
    const op = { add: [], del: A.items.filter(i => gone.has(i.id)) };
    A.items = A.items.filter(i => !gone.has(i.id));
    this.sel = null; this.nudgeOp = null;
    A.commit(op);
    this._refresh();
    this.v.paint();
  }

  // Keys for a selected annotation (the global handler asks us first, so arrows nudge instead of turning pages).
  handleKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const tool = TOOL_KEYS[e.key.toLowerCase()];            // F fingering, H highlight, N note, E erase, M move
    if (!this.on) {                                          // a tool key opens the toolbar straight onto that tool
      if (!tool || !this.anns || !this.v.geom || this.v.busy) return false;
      if (!e.repeat) { this.setOn(true); this._selectTool(tool); this._clearHint(); }
      return true;
    }
    if (!this.pop.hidden) return false;
    if (tool && !e.repeat) { if (!this.menu.hidden) this._closeMenu(); this._selectTool(tool); this._clearHint(); return true; }
    if (tool) return true;
    if (this.tool !== 'move' || !this.sel) return false;
    const dirs = { ArrowLeft: '-1,0', ArrowRight: '1,0', ArrowUp: '0,-1', ArrowDown: '0,1' };
    if (dirs[e.key]) { this._nudgeBy(dirs[e.key], e.shiftKey); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { this._deleteSel(); return true; }
    return false;
  }

  _showHint(e, pt) {
    this._clearHint();
    if (!this.on || !pt || (this.pending && !this.pop.hidden)) return;       // (while a fingering is being typed, its box stays put)
    const lr = this.layer.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, cs = this.v.scale;
    if (this.hint.width !== Math.round(lr.width * dpr) || this.hint.height !== Math.round(lr.height * dpr)) this._sizeHint();   // the screen changed size without a resize event (e.g. the iPad's toolbars): stretched previews would sit off the finger
    const c = this.hint.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const X = e.clientX - lr.left, Y = e.clientY - lr.top;
    if (this.tool === 'fing') {                            // the pointer is a box the size of one fingering character
      this._drawFingBox(c, pt, X, Y);
    } else if (this.tool === 'erase') {
      const r = ERASER[this.size].r * dAt(this.layout, pt.p, pt.y) * cs;
      c.lineWidth = 1.5; c.strokeStyle = 'rgba(220,40,40,.9)'; c.beginPath(); c.arc(X, Y, r, 0, Math.PI * 2); c.stroke();
    } else if (this.tool === 'note') {
      const sn = snapNote(this.layout, pt.p, pt.y);
      const vr = this.v.view.getBoundingClientRect();
      const gy = vr.top + (pt.cy - 0) + (sn.y - pt.y) * cs - lr.top;
      c.save(); c.translate(X, gy); c.rotate(NOTE.rot); c.fillStyle = 'rgba(0,0,0,.35)';
      c.beginPath(); c.ellipse(0, 0, NOTE.rx * sn.d * cs, NOTE.ry * sn.d * cs, 0, 0, Math.PI * 2); c.fill(); c.restore();
    } else if (this.tool === 'hl' && this.st?.moved && this.st.start) {
      const vr = this.v.view.getBoundingClientRect();
      const x0 = vr.left - lr.left + Math.min(this.st.start.cx, pt.cx), x1 = vr.left - lr.left + Math.max(this.st.start.cx, pt.cx);
      const y0 = vr.top - lr.top + Math.min(this.st.start.cy, pt.cy), y1 = vr.top - lr.top + Math.max(this.st.start.cy, pt.cy);
      c.fillStyle = this.color; c.globalAlpha = 0.45; c.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }
}

Object.assign(MB, { Annotator, drawAnnotations: draw });
})();
