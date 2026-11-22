# Music Book

Vanilla HTML/CSS/JS PWA (no build step). Upload sheet music into a library, open a piece, and turn pages with MIDI pedals/keys.

## Run
No server or build: open `index.html` in Chrome (works from file://), or publish the folder to GitHub Pages (https://dondo.github.io/music-book/). All code is plain `<script>` tags sharing one `MB` namespace (load order is in index.html) so file:// works; the service worker only registers on http(s).

## Layout
- `js/app.js` – library screen, upload/drag-drop, wiring
- `js/library.js` – IndexedDB storage (`pieces` metadata, `files` blobs, `folders`); stays on this browser/device. A piece has `folderId` (null = top level) and `order` (play order within its folder)
- `js/viewer.js` – full-screen page viewer, [x] close, remembers last page per piece
- `js/readers/` – **format readers**. `index.js` documents the interface and holds the registry (add `<script>` tags in index.html and sw.js for new files); `pdf-reader.js` (pdf.js 3.11 classic build, vendored in `vendor/pdfjs`; v3 is used because newer pdf.js is ES-module-only and won't load from file://), `image-reader.js` (png/jpg/webp). Add a format = new file + one line in `READERS`.
- `js/input/midi.js` – Web MIDI device manager (selectable inputs)
- `js/input/bindings.js` – action bindings + "Learn"; defaults: sustain pedal (CC64) = next, soft pedal (CC67) = previous
- `js/settings-ui.js` – ⚙ dialog: pick MIDI inputs, learn pedals/keys, live MIDI monitor
- `sw.js` – offline app-shell cache (bump `VERSION` when files change)

## Folders
One level deep. Open a folder to see its pieces as an ordered list: reorder with the ▲▼ buttons or by dragging the ⋮⋮ grip. Move a piece with 📂 (or drag it onto a folder card, or onto the "Music Book" crumb to take it out). Adding music while a folder is open appends to that folder. Deleting a folder moves its pieces to the top level.
In the viewer, ⏮/⏭ (or `[` / `]`, or MIDI actions "Previous/Next piece in folder" once learned) jump to the neighbouring piece. Setting: page-turn past the last page can continue into the next piece automatically (off by default).

## Adding a whole folder
"+ Add folder" (or dragging a folder onto the page) creates a new library folder named after the source folder and imports its supported files (PDF, images) in natural file-name order ("2 …" before "10 …"). Only files directly inside the folder are imported; subfolders are skipped and reported. A name that already exists gets " (2)" etc. Dropping loose files adds them to the open folder as before.

## Duplicate detection
Every piece stores a SHA-256 hash of its file bytes. On import, files whose hash matches something already in the library trigger a dialog:
- **Add here** – move the existing piece to where you are importing (only if it exists in exactly one place; otherwise it behaves like Both places)
- **Only there** – leave it where it is, skip the upload
- **Both places** – keep it there and add a shared copy here
Names are ignored. A duplicate already in the destination folder is just skipped. The same file appearing twice in one import is skipped (same destination) or shared (different folders) automatically. Pieces added before this feature are hashed once in the background at startup. Only byte-identical files match; a re-saved or re-exported copy of the same score will not.

## Shared copies (one file, several places)
A piece record = one *placement* (title, folder, position, last page). Its `fileId` names the stored blob in the `files` store; copies made with 🔗 (or "Both places") are extra placements pointing at the same `fileId`, so the bytes are stored once. Like a hard link, the stored file is deleted only when its last placement is removed, so removing the "original" never breaks the others. Titles, play order and last page are independent per placement; cards show "🔗 also in …".

## Controls
Keyboard: → ↓ Space PageDown next; ← ↑ PageUp previous; Esc close. Tap left third / rest of page, or swipe.
