(function () {
'use strict';
// Full-screen page viewer: shows one page at a time, fit to the window.
// Page turning is triggered by whoever owns the Viewer (keyboard, MIDI, taps).
// `siblings` is the ordered list of pieces in the piece's folder, so you can jump piece to piece.
const { readerById, getFile, updatePiece } = MB;

class Viewer {
  constructor(root, { onClose, onPageChange, getOptions } = {}) {
    this.root = root;
    this.stage = root.querySelector('.stage');
    this.indicator = root.querySelector('.page-indicator');
    this.titleEl = root.querySelector('.viewer-title');
    this.prevBtn = root.querySelector('.piece-prev');
    this.nextBtn = root.querySelector('.piece-next');
    this.piece = null;
    this.doc = null;
    this.page = 1;
    this.token = 0;
    this.siblings = [];
    this.index = 0;
    this.onClose = onClose;
    this.onPageChange = onPageChange;
    this.getOptions = getOptions;

    root.querySelector('.close').addEventListener('click', e => { e.stopPropagation(); this.close(); });
    this.prevBtn.addEventListener('click', e => { e.stopPropagation(); this.prevPiece(); });
    this.nextBtn.addEventListener('click', e => { e.stopPropagation(); this.nextPiece(); });

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
      if (!this.isOpen) return;
      clearTimeout(t);
      t = setTimeout(() => this.render(), 150);
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

  async _enter(piece, doc, startPage) {
    const old = this.doc;
    this.piece = piece;
    this.doc = doc;
    const want = startPage === 'last' ? doc.pageCount : (startPage || 1);
    this.page = Math.min(Math.max(1, want), doc.pageCount);
    old?.destroy();
    this.titleEl.textContent = piece.title;
    this.updateNav();
    this.root.hidden = false;
    document.body.classList.add('viewing');
    await this.render();
  }

  async open(piece, siblings = [piece]) {
    const doc = await this._load(piece);
    this.siblings = siblings.length ? siblings : [piece];
    this.index = Math.max(0, this.siblings.findIndex(p => p.id === piece.id));
    await this._enter(piece, doc, piece.lastPage || 1);
  }

  async switchPiece(delta, startPage = 1) {
    const i = this.index + delta;
    if (!this.doc || this._switching || i < 0 || i >= this.siblings.length) return false;
    this._switching = true;
    try {
      const piece = this.siblings[i];
      const doc = await this._load(piece);
      if (!this.doc) { doc.destroy(); return false; }      // closed while loading
      this.index = i;
      await this._enter(piece, doc, startPage);
      return true;
    } catch (e) {
      console.error(e);
      this.flashIndicator();
      return false;
    } finally {
      this._switching = false;
    }
  }

  nextPiece() { return this.switchPiece(1, 1); }
  prevPiece() { return this.switchPiece(-1, 1); }

  close() {
    if (!this.doc) return;
    this.token++;
    this.doc.destroy();
    this.doc = null;
    this.piece = null;
    this.siblings = [];
    this.stage.replaceChildren();
    this.root.hidden = true;
    document.body.classList.remove('viewing');
    this.onClose?.();
  }

  next() { return this.goTo(this.page + 1); }
  prev() { return this.goTo(this.page - 1); }

  async goTo(n) {
    if (!this.doc) return;
    const autoAdvance = !!this.getOptions?.().autoAdvance;
    if (n > this.doc.pageCount) {
      if (autoAdvance && await this.switchPiece(1, 1)) return;
      this.flashIndicator();
      return;
    }
    if (n < 1) {
      if (autoAdvance && await this.switchPiece(-1, 'last')) return;
      this.flashIndicator();
      return;
    }
    if (n === this.page) { this.flashIndicator(); return; }
    this.page = n;
    await this.render();
    updatePiece(this.piece.id, { lastPage: n });
    this.onPageChange?.(this.piece, n);
  }

  async render() {
    if (!this.doc) return;
    const my = ++this.token;
    this.updateIndicator();
    const rect = this.stage.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.className = 'page';
    const ok = await this.doc.renderPage(this.page, canvas, {
      maxWidth: Math.floor(rect.width) - 12,
      maxHeight: Math.floor(rect.height) - 12,
      dpr: window.devicePixelRatio || 1,
    });
    if (!ok || my !== this.token) return;                 // superseded by a newer render
    this.stage.replaceChildren(canvas);                   // swap in only when ready: no blank flash
  }

  updateNav() {
    const many = this.siblings.length > 1;
    this.prevBtn.hidden = this.nextBtn.hidden = !many;
    this.prevBtn.disabled = !this.hasPrevPiece;
    this.nextBtn.disabled = !this.hasNextPiece;
  }

  updateIndicator() {
    const many = this.siblings.length > 1;
    this.indicator.textContent = `${this.page} / ${this.doc.pageCount}` + (many ? ` · piece ${this.index + 1} of ${this.siblings.length}` : '');
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
