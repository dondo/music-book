(function () {
'use strict';
const { readerById, getFile, updatePiece } = MB;
// Full-screen page viewer: shows one page at a time, fit to the window.
// Page turning is triggered by whoever owns the Viewer (keyboard, MIDI, taps).


class Viewer {
  constructor(root, { onClose, onPageChange } = {}) {
    this.root = root;
    this.stage = root.querySelector('.stage');
    this.indicator = root.querySelector('.page-indicator');
    this.titleEl = root.querySelector('.viewer-title');
    this.piece = null;
    this.doc = null;
    this.page = 1;
    this.token = 0;
    this.onClose = onClose;
    this.onPageChange = onPageChange;

    root.querySelector('.close').addEventListener('click', e => { e.stopPropagation(); this.close(); });

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

  async open(piece) {
    const reader = readerById(piece.readerId);
    if (!reader) throw new Error(`No reader for format "${piece.readerId}"`);
    const blob = await getFile(piece.id);
    if (!blob) throw new Error('The stored file for this piece is missing.');
    const doc = await reader.open(blob);
    this.piece = piece;
    this.doc = doc;
    this.page = Math.min(Math.max(1, piece.lastPage || 1), doc.pageCount);
    this.titleEl.textContent = piece.title;
    this.root.hidden = false;
    document.body.classList.add('viewing');
    await this.render();
  }

  close() {
    if (!this.doc) return;
    this.token++;
    this.doc.destroy();
    this.doc = null;
    this.piece = null;
    this.stage.replaceChildren();
    this.root.hidden = true;
    document.body.classList.remove('viewing');
    this.onClose?.();
  }

  next() { return this.goTo(this.page + 1); }
  prev() { return this.goTo(this.page - 1); }

  async goTo(n) {
    if (!this.doc) return;
    n = Math.min(Math.max(1, n), this.doc.pageCount);
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

  updateIndicator() {
    this.indicator.textContent = `${this.page} / ${this.doc.pageCount}`;
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
