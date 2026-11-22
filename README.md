# Music Book

Vanilla HTML/CSS/JS PWA (no build step). Upload sheet music into a library, open a piece, and turn pages with MIDI pedals/keys.

## Run
No server or build: open `index.html` in Chrome (works from file://), or publish the folder to GitHub Pages (https://dondo.github.io/music-book/). All code is plain `<script>` tags sharing one `MB` namespace (load order is in index.html) so file:// works; the service worker only registers on http(s).

## Layout
- `js/app.js` – library screen, upload/drag-drop, wiring
- `js/library.js` – IndexedDB storage (`pieces` metadata + `files` blobs); stays on this browser/device
- `js/viewer.js` – full-screen page viewer, [x] close, remembers last page per piece
- `js/readers/` – **format readers**. `index.js` documents the interface and holds the registry (add `<script>` tags in index.html and sw.js for new files); `pdf-reader.js` (pdf.js 3.11 classic build, vendored in `vendor/pdfjs`; v3 is used because newer pdf.js is ES-module-only and won't load from file://), `image-reader.js` (png/jpg/webp). Add a format = new file + one line in `READERS`.
- `js/input/midi.js` – Web MIDI device manager (selectable inputs)
- `js/input/bindings.js` – action bindings + "Learn"; defaults: sustain pedal (CC64) = next, soft pedal (CC67) = previous
- `js/settings-ui.js` – ⚙ dialog: pick MIDI inputs, learn pedals/keys, live MIDI monitor
- `sw.js` – offline app-shell cache (bump `VERSION` when files change)

## Controls
Keyboard: → ↓ Space PageDown next; ← ↑ PageUp previous; Esc close. Tap left third / rest of page, or swipe.
