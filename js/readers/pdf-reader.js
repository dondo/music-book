(function () {
'use strict';

// Resolved relative to index.html. If a Worker can't start (e.g. opened from file://),
// pdf.js falls back to running on the main thread, which is fine for sheet music.
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';


function canvasToBlob(canvas, type, quality) {
  return new Promise(res => canvas.toBlob(res, type, quality));
}

const __default = {
  id: 'pdf',
  name: 'PDF',
  extensions: ['pdf'],
  mimeTypes: ['application/pdf'],

  async open(blob) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const loadingTask = pdfjsLib.getDocument({
      data,
    });
    const pdf = await loadingTask.promise;

    let current = null; // in-flight render task, cancelled if a newer render starts

    async function renderPage(n, canvas, { maxWidth, maxHeight, dpr = window.devicePixelRatio || 1 }) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(maxWidth / base.width, maxHeight / base.height);
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
      canvas.style.height = Math.floor(viewport.height / dpr) + 'px';
      if (current) { try { current.cancel(); } catch {} }
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      current = task;
      try {
        await task.promise;
      } catch (e) {
        if (e?.name === 'RenderingCancelledException') return false;
        throw e;
      } finally {
        if (current === task) current = null;
      }
      return true;
    }

    async function thumbnail(maxSize = 360) {
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const s = maxSize / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale: s });
      const c = document.createElement('canvas');
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      return canvasToBlob(c, 'image/jpeg', 0.8);
    }

    // Page size in PDF units (rotation applied).
    async function getPageSize(n) {
      const page = await pdf.getPage(n);
      const v = page.getViewport({ scale: 1 });
      return { width: v.width, height: v.height };
    }

    // Render just the rectangle (x, y, w, h) of page n (in page units) at `scale` CSS px per unit.
    // The canvas is sized to the rectangle; only that part is drawn.
    async function renderRegion(n, canvas, { x, y, w, h, scale, dpr = window.devicePixelRatio || 1 }) {
      const page = await pdf.getPage(n);
      const s = scale * dpr;
      canvas.width = Math.max(1, Math.round(w * s));
      canvas.height = Math.max(1, Math.round(h * s));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const viewport = page.getViewport({ scale: s, offsetX: -x * s, offsetY: -y * s });
      await page.render({ canvasContext: ctx, viewport }).promise;
      return true;
    }

    return {
      pageCount: pdf.numPages,
      renderPage,
      getPageSize,
      renderRegion,
      thumbnail,
      destroy() { loadingTask.destroy(); },
    };
  },
};
MB.pdfReader = __default;
})();
