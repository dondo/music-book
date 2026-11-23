(function () {
'use strict';
// Single-image "score" (a scan or photo of one page). Mainly here to prove the
// reader interface is format-agnostic; see readers/index.js for the contract.

function canvasToBlob(canvas, type, quality) {
  return new Promise(res => canvas.toBlob(res, type, quality));
}

const __default = {
  id: 'image',
  name: 'Image',
  extensions: ['png', 'jpg', 'jpeg', 'webp'],
  mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],

  async open(blob) {
    const bitmap = await createImageBitmap(blob);

    async function renderPage(n, canvas, { maxWidth, maxHeight, dpr = window.devicePixelRatio || 1 }) {
      const scale = Math.min(maxWidth / bitmap.width, maxHeight / bitmap.height);
      const w = Math.floor(bitmap.width * scale * dpr);
      const h = Math.floor(bitmap.height * scale * dpr);
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = Math.floor(w / dpr) + 'px';
      canvas.style.height = Math.floor(h / dpr) + 'px';
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      return true;
    }

    async function thumbnail(maxSize = 360) {
      const s = maxSize / Math.max(bitmap.width, bitmap.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(bitmap.width * s));
      c.height = Math.max(1, Math.floor(bitmap.height * s));
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(bitmap, 0, 0, c.width, c.height);
      return canvasToBlob(c, 'image/jpeg', 0.8);
    }

    async function getPageSize() { return { width: bitmap.width, height: bitmap.height }; }

    async function renderRegion(n, canvas, { x, y, w, h, scale, dpr = window.devicePixelRatio || 1 }) {
      const s = scale * dpr;
      canvas.width = Math.max(1, Math.round(w * s));
      canvas.height = Math.max(1, Math.round(h * s));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, x, y, w, h, 0, 0, canvas.width, canvas.height);
      return true;
    }

    return { pageCount: 1, renderPage, getPageSize, renderRegion, thumbnail, destroy() { bitmap.close?.(); } };
  },
};
MB.imageReader = __default;
})();
