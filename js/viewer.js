(function () {
'use strict';
// Full-screen viewer. For formats the layout analyser understands (PDFs, images) the music is cut into
// blocks (systems) at blank rows, and each screen shows as many whole blocks as fit, so a staff is never
// cut off and page turns advance by screen. Anything else falls back to one fitted page per turn.
// `siblings` is the ordered list of pieces in the piece's folder, so you can jump piece to piece.
const { readerById, getFile, getLayout, putLayout, analyzeDocument, packScreens, updatePiece } = MB;

const PAD = 12;               // breathing room around the music, in CSS px
const MIN_ZOOM = 0.3;

class Viewer {
  constructor(root, { onClose, onPageChange, getOptions, onOptionChange } = {}) {
    this.root = root;
    this.stage = root.querySelector('.stage');
    this.indicator = root.querySelector('.page-indicator');
    this.titleEl = root.querySelector('.viewer-title');
    this.prevBtn = root.querySelector('.piece-prev');
    this.nextBtn = root.querySelector('.piece-next');
    this.zoomBox = root.querySelector('.zoom');
    this.zoomLabel = root.querySelector('.zoom-label');
    this.extrasBtn = root.querySelector('.extras-toggle');
    this.busyEl = root.querySelector('.busy');
    this.piece = null;
    this.doc = null;
    this.layout = null;          // null = fallback mode (one page per screen)
    this.screens = [];           // arrays of block indices (fallback: [page-1])
    this.screen = 0;
    this.zoom = 1;               // relative to fit-width; 1 = widest possible
    this.maxZoom = 1;
    this.token = 0;
    this.cache = new Map();
    this.cacheKey = '';
    this.siblings = [];
    this.index = 0;
    this.busy = false;
    this.onClose = onClose;
    this.onPageChange = onPageChange;
    this.getOptions = getOptions;
    this.onOptionChange = onOptionChange;
    this.vis = [];                // indices of the blocks currently shown
    this.geom = null;             // where each block sits on the current screen's canvas (for annotations)
    this.base = null;             // the music alone (cached screen canvas)
    this.view = null;             // what is on screen: base + annotations
    this.ann = new MB.Annotator(this);

    root.querySelector('.close').addEventListener('click', e => { e.stopPropagation(); this.close(); });
    this.prevBtn.addEventListener('click', e => { e.stopPropagation(); this.prevPiece(); });
    this.nextBtn.addEventListener('click', e => { e.stopPropagation(); this.nextPiece(); });
    root.querySelector('.zoom-in').addEventListener('click', e => { e.stopPropagation(); this.zoomBy(1.15); });
    root.querySelector('.zoom-out').addEventListener('click', e => { e.stopPropagation(); this.zoomBy(1 / 1.15); });
    this.zoomLabel.addEventListener('click', e => { e.stopPropagation(); this.toggleFit(); });
    this.extrasBtn.addEventListener('click', e => { e.stopPropagation(); this.toggleExtras(); });

    // tap zones: left third = previous, the rest = next; horizontal swipe also turns pages
    let startX = null;
    this.stage.addEventListener('pointerdown', e => { startX = e.clientX; });
    this.stage.addEventListener('pointerup', e => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) > 50) { dx < 0 ? this.next() : this.prev(); return; }
      const rect = this.stage.getBoundingClientRect();
      (e.clientX - rect.left) < rect.width / 3 ? this.prev() : this.next();
    });

    let t = null;
    window.addEventListener('resize', () => {
      if (!this.isOpen || this.busy) return;
      clearTimeout(t);
      t = setTimeout(() => { this._repack(); this.render(); }, 150);
    });
  }

  get isOpen() { return !!this.doc; }
  get hasNextPiece() { return this.index < this.siblings.length - 1; }
  get hasPrevPiece() { return this.index > 0; }

  async _load(piece) {
    const reader = readerById(piece.readerId);
    if (!reader) throw new Error(`No reader for format "${piece.readerId}"`);
    const blob = await getFile(piece.fileId || piece.id);
    if (!blob) throw new Error('The stored file for this piece is missing.');
    return reader.open(blob);
  }

  _setBusy(text) {
    this.busy = !!text;
    this.busyEl.hidden = !text;
    this.busyEl.textContent = text || '';
  }

  // Get (or compute and cache) the layout. Returns null when this format can't be analysed.
  async _getLayout(piece, doc) {
    if (!doc.renderRegion || !doc.getPageSize) return null;
    const fid = piece.fileId || piece.id;
    try {
      const saved = await getLayout(fid);
      if (saved && saved.v === MB.LAYOUT_VERSION && saved.pages?.length === doc.pageCount) return saved;
      this._setBusy('Analyzing layout…');
      const layout = await analyzeDocument(doc, (i, n) => { if (this.doc === doc) this._setBusy(`Analyzing layout… ${i} / ${n}`); });
      await putLayout(fid, layout);
      return layout;
    } catch (e) {
      console.warn('Layout analysis failed; showing whole pages instead.', e);
      return null;
    }
  }

  async _enter(piece, doc, start) {
    const old = this.doc;
    this.piece = piece;
    this.doc = doc;
    this.ann.detach();
    this.geom = this.base = this.view = null;
    this.layout = null;
    this.screens = [];
    this.cache.clear();
    old?.destroy();
    this.titleEl.textContent = piece.title;
    this.updateNav();
    this.root.hidden = false;
    document.body.classList.add('viewing');
    this.stage.replaceChildren();
    const layout = await this._getLayout(piece, doc);
    this._setBusy(null);
    if (this.doc !== doc) return;                        // closed or switched while analysing
    this.layout = layout;
    if (layout) {
      await this.ann.attach(piece.fileId || piece.id, layout);
      if (this.doc !== doc) return;
    }
    this.hideExtras = !!this.getOptions?.().hideExtras;
    this.zoomBox.hidden = !layout;
    this.hasExtras = !!layout && layout.blocks.some(b => b.kind === 'header' || b.kind === 'footer');
    this.extrasBtn.hidden = !this.hasExtras;
    this.zoom = Number(piece.zoom) > 0 ? piece.zoom : 1;
    this.zoomBack = null;
    this._repack();
    if (start === 'last') this.screen = this.screens.length - 1;
    else if (start === 'resume') this.screen = this._screenOfPosition(piece);
    else this.screen = 0;
    await this.render();
  }

  // Which screen holds the position we last left off at?
  _screenOfPosition(piece) {
    if (this.layout) {
      let b = Number.isInteger(piece.lastBlock) ? piece.lastBlock : -1;
      if (b < 0 || b >= this.layout.blocks.length) {
        b = this.layout.blocks.findIndex(x => x.p >= (piece.lastPage || 1));
        if (b < 0) b = 0;
      }
      return Math.max(0, this.screens.findIndex(s => s.includes(b)));
    }
    return Math.min(Math.max(0, (piece.lastPage || 1) - 1), this.screens.length - 1);
  }

  _geometry() {
    const rect = this.stage.getBoundingClientRect();
    return { w: Math.max(50, Math.floor(rect.width) - PAD), h: Math.max(50, Math.floor(rect.height) - PAD) };
  }

  // Recompute zoom limits and which blocks go on which screen. Keeps the first block on screen in view.
  _repack() {
    if (!this.doc) return;
    if (!this.layout) {
      this.screens = Array.from({ length: this.doc.pageCount }, (_, i) => [i]);
      this.screen = Math.min(this.screen, this.screens.length - 1);
      this.updateZoomLabel();
      return;
    }
    const anchor = this.screens[this.screen]?.[0] ?? 0;
    const { w, h } = this._geometry();
    const L = this.layout;
    const hide = this.hideExtras;
    this.vis = L.blocks.map((b, i) => i).filter(i => !(hide && (L.blocks[i].kind === 'header' || L.blocks[i].kind === 'footer')));
    const shown = this.vis.map(i => L.blocks[i]);
    const cw = L.x1 - L.x0;
    const fitW = w / cw;
    const tallest = Math.max(...shown.map(b => b.y1 - b.y0));
    this.maxZoom = Math.min(1, h / (tallest * fitW));    // never wider than the page, never taller than the screen
    this.zoom = Math.min(Math.max(this.zoom, MIN_ZOOM), this.maxZoom);
    this.scale = fitW * this.zoom;
    this.screens = packScreens(shown, this.scale, h).map(s => s.map(k => this.vis[k]));
    let at = this.screens.findIndex(s => s.includes(anchor));
    if (at < 0) at = this.screens.findIndex(s => s[0] > anchor);   // anchor was hidden: next shown block
    this.screen = at < 0 ? this.screens.length - 1 : at;
    const key = `${this.scale.toFixed(4)}|${h}|${hide ? 1 : 0}|${window.devicePixelRatio || 1}`;
    if (key !== this.cacheKey) { this.cache.clear(); this.cacheKey = key; }
    this.updateZoomLabel();
  }

  updateZoomLabel() {
    this.extrasBtn.setAttribute('aria-pressed', this.hideExtras ? 'true' : 'false');
    this.extrasBtn.title = this.hideExtras ? 'Show headers and footers ( h )' : 'Hide headers and footers ( h )';
    // The button shows what a click will do: "full screen" = fit to width (100%), "full page" = back to the previous zoom.
    const pct = Math.round(this.zoom * 100), back = this.zoomBack != null;
    const icon = back
      ? '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M9.5 12.5h5M9.5 16h5"/>'
      : '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>';
    this.zoomLabel.innerHTML = `<svg class="ic" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span class="sr">${pct}%</span>`;
    this.zoomLabel.title = back ? `Back to ${Math.round(this.zoomBack * 100)}% (now ${pct}%)` : `Fit to width ( 0 ) — now ${pct}%`;
    this.zoomLabel.setAttribute('aria-label', back ? `Back to ${Math.round(this.zoomBack * 100)} percent` : `Fit to width, now ${pct} percent`);
    this.root.querySelector('.zoom-in').disabled = this.zoom >= this.maxZoom - 1e-6;
    this.root.querySelector('.zoom-out').disabled = this.zoom <= MIN_ZOOM + 1e-6;
  }

  async toggleExtras() {
    if (!this.doc || !this.layout || !this.hasExtras || this.busy) return;
    this.hideExtras = !this.hideExtras;
    this._repack();
    this.onOptionChange?.({ hideExtras: this.hideExtras });
    await this.render();
    this._remember();
  }

  async zoomBy(factor) { return this.setZoom(this.zoom * factor); }
  async fitWidth() { return this.setZoom(1); }

  // Clicking the zoom label fits to width; clicking it again (with no zoom change in between) goes back to the size it was.
  async toggleFit() {
    if (this.zoomBack != null) { const z = this.zoomBack; return this.setZoom(z, true); }
    const was = this.zoom;
    if (Math.abs(was - 1) < 1e-6) return this.setZoom(1);
    await this.setZoom(1, true);
    if (Math.abs(this.zoom - 1) < 1e-6) { this.zoomBack = was; this.updateZoomLabel(); }
  }

  async setZoom(z, keepBack = false) {
    if (!this.doc || !this.layout || this.busy) return;
    if (!keepBack || this.zoomBack === z) { this.zoomBack = null; this.updateZoomLabel(); }   // any other zoom change forgets the saved size
    const before = this.zoom;
    this.zoom = z;
    this._repack();
    if (Math.abs(this.zoom - before) < 1e-6) { this.flashIndicator(); return; }
    updatePiece(this.piece.id, { zoom: this.zoom });
    this.piece.zoom = this.zoom;
    await this.render();
    this._remember();
  }

  async open(piece, siblings = [piece]) {
    const doc = await this._load(piece);
    this.siblings = siblings.length ? siblings : [piece];
    this.index = Math.max(0, this.siblings.findIndex(p => p.id === piece.id));
    await this._enter(piece, doc, 'resume');
  }

  async switchPiece(delta, start = 'first') {
    const i = this.index + delta;
    if (!this.doc || this._switching || this.busy || i < 0 || i >= this.siblings.length) return false;
    this._switching = true;
    try {
      const piece = this.siblings[i];
      const doc = await this._load(piece);
      if (!this.doc) { doc.destroy(); return false; }      // closed while loading
      this.index = i;
      await this._enter(piece, doc, start);
      return true;
    } catch (e) {
      console.error(e);
      this._setBusy(null);
      this.flashIndicator();
      return false;
    } finally {
      this._switching = false;
    }
  }

  nextPiece() { return this.switchPiece(1, 'first'); }
  prevPiece() { return this.switchPiece(-1, 'first'); }

  close() {
    if (!this.doc) return;
    this.token++;
    this.ann.detach();
    this.geom = this.base = this.view = null;
    this.doc.destroy();
    this.doc = null;
    this.layout = null;
    this.piece = null;
    this.siblings = [];
    this.cache.clear();
    this._setBusy(null);
    this.stage.replaceChildren();
    this.root.hidden = true;
    document.body.classList.remove('viewing');
    this.onClose?.();
  }

  next() { return this.goTo(this.screen + 1); }
  prev() { return this.goTo(this.screen - 1); }

  async goTo(n) {
    if (!this.doc || this.busy) return;
    const autoAdvance = !!this.getOptions?.().autoAdvance;
    if (n >= this.screens.length) {
      if (autoAdvance && await this.switchPiece(1, 'first')) return;
      this.flashIndicator();
      return;
    }
    if (n < 0) {
      if (autoAdvance && await this.switchPiece(-1, 'last')) return;
      this.flashIndicator();
      return;
    }
    if (n === this.screen) { this.flashIndicator(); return; }
    this.screen = n;
    await this.render();
    this._remember();
  }

  // Save where we are: the page of the first block on screen, and that block (so zoom changes can restore it).
  _remember() {
    if (!this.piece) return;
    const first = this.screens[this.screen]?.[0] ?? 0;
    const page = this.layout ? this.layout.blocks[first].p : first + 1;
    const patch = { lastPage: page };
    if (this.layout) patch.lastBlock = first;
    Object.assign(this.piece, patch);
    updatePiece(this.piece.id, patch);
    this.onPageChange?.(this.piece, page);
  }

  // Draw one screen: its blocks stacked on a single canvas.
  async _buildScreen(idx) {
    const { w, h } = this._geometry();
    const canvas = document.createElement('canvas');
    canvas.className = 'page';
    if (!this.layout) {
      const ok = await this.doc.renderPage(idx + 1, canvas, { maxWidth: w, maxHeight: h, dpr: window.devicePixelRatio || 1 });
      return ok ? canvas : null;
    }
    const L = this.layout, dpr = window.devicePixelRatio || 1, scale = this.scale;
    const blocks = this.screens[idx].map(i => L.blocks[i]);
    const cw = L.x1 - L.x0;
    const wPx = Math.max(1, Math.round(cw * scale * dpr));
    const ys = [0];
    let acc = 0;
    for (const b of blocks) { acc += (b.y1 - b.y0) * scale * dpr; ys.push(Math.round(acc)); }
    canvas.width = wPx;
    canvas.height = Math.max(1, ys[ys.length - 1]);
    canvas.style.width = `${wPx / dpr}px`;
    canvas.style.height = `${canvas.height / dpr}px`;
    canvas._geom = { x0: L.x0, S: scale * dpr, dpr, blocks: blocks.map((b, k) => ({ p: b.p, y0: b.y0, y1: b.y1, top: ys[k], h: ys[k + 1] - ys[k] })) };
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const doc = this.doc;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      const tmp = document.createElement('canvas');
      await doc.renderRegion(b.p, tmp, { x: L.x0, y: b.y0, w: cw, h: b.y1 - b.y0, scale, dpr });
      if (this.doc !== doc) return null;
      ctx.drawImage(tmp, 0, ys[k], wPx, ys[k + 1] - ys[k]);
    }
    return canvas;
  }

  _screenCanvas(idx) {
    if (idx < 0 || idx >= this.screens.length) return null;
    let p = this.cache.get(idx);
    if (!p) {
      p = this._buildScreen(idx).catch(e => { console.error(e); return null; });
      this.cache.set(idx, p);
      p.then(c => { if (!c && this.cache.get(idx) === p) this.cache.delete(idx); });
    }
    return p;
  }

  async render() {
    if (!this.doc) return;
    const my = ++this.token;
    this.updateIndicator();
    const idx = this.screen;
    const canvas = await this._screenCanvas(idx);
    if (!canvas || my !== this.token) return;              // superseded by a newer render
    if (canvas._geom) {                                    // composed screen: show music + annotations on a copy
      const view = document.createElement('canvas');
      view.className = 'page';
      view.width = canvas.width; view.height = canvas.height;
      view.style.width = canvas.style.width; view.style.height = canvas.style.height;
      this.base = canvas; this.view = view; this.geom = canvas._geom;
      this.stage.replaceChildren(view);                    // swap in only when ready: no blank flash
      this.paint();                                        // after attaching: the annotation overlay measures the canvas on screen
    } else {
      this.base = this.view = this.geom = null;
      this.stage.replaceChildren(canvas);
    }
    for (const k of [...this.cache.keys()]) if (k < idx - 1 || k > idx + 2) this.cache.delete(k);
    this._screenCanvas(idx + 1);                           // get the next page turn ready
  }

  // Redraw the current screen: the music, then the annotations on top.
  paint() {
    if (!this.view || !this.base) return;
    const ctx = this.view.getContext('2d');
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.base, 0, 0);
    if (this.ann.anns) MB.drawAnnotations(ctx, this.geom, this.ann.anns.items, this.layout, this.base);
    if (this.ann.on) this.ann.overlay();
  }

  toggleAnnotate() { if (this.doc && this.layout && !this.busy) this.ann.setOn(!this.ann.on); }
  annotateUndo() { if (this.ann.on) this.ann.undo(); }

  // Esc goes up one level: close the fingering box, then leave annotating, then close the music.
  handleEscape() {
    if (this.ann.escape()) return;
    this.close();
  }

  updateNav() {
    const many = this.siblings.length > 1;
    this.prevBtn.hidden = this.nextBtn.hidden = !many;
    this.prevBtn.disabled = !this.hasPrevPiece;
    this.nextBtn.disabled = !this.hasNextPiece;
  }

  updateIndicator() {
    const many = this.siblings.length > 1;
    this.indicator.textContent = `${this.screen + 1} / ${this.screens.length}` + (many ? ` · piece ${this.index + 1} of ${this.siblings.length}` : '');
    this.flashIndicator();
  }

  flashIndicator() {
    this.indicator.classList.add('show');
    clearTimeout(this._ind);
    this._ind = setTimeout(() => this.indicator.classList.remove('show'), 1500);
  }
}

MB.Viewer = Viewer;
})();
