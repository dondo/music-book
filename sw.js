// App-shell cache so Music Book opens offline. Bump VERSION when files change.
const VERSION = 'mb-761c80e';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest', 'icons/icon.svg',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
  'js/version.js', 'js/namespace.js', 'js/debug.js', 'js/library.js', 'js/theme.js', 'js/sync.js', 'js/sync-ui.js', 'js/readers/pdf-reader.js', 'js/readers/image-reader.js',
  'js/readers/index.js', 'js/input/midi.js', 'js/input/bindings.js',
  'js/layout.js', 'js/annotate.js', 'js/viewer.js', 'js/settings-ui.js', 'js/app.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// network first (so edits show up), fall back to cache offline
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
