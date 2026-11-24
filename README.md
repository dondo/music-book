# Music Book

Vanilla HTML/CSS/JS PWA (no build step). Upload sheet music into a library, open a piece, and turn pages with MIDI pedals/keys.

## Run
No server or build: open `index.html` in Chrome (works from file://), or publish the folder to GitHub Pages (https://dondo.github.io/music-book/). All code is plain `<script>` tags sharing one `MB` namespace (load order is in index.html) so file:// works; the service worker only registers on http(s).

## Layout
- `js/app.js` – library screen, upload/drag-drop, wiring
- `js/library.js` – IndexedDB storage (`pieces` metadata, `files` blobs, `folders`, `layouts` = cached layout analysis per file, `annotations` = markings per file); stays on this browser/device. A piece has `folderId` (null = top level) and `order` (play order within its folder)
- `js/viewer.js` – full-screen viewer, [x] close, zoom; remembers position and zoom per piece
- `js/annotate.js` – annotations (fingerings, highlights, added notes, eraser): data model, renderer, tool UI
- `js/layout.js` – finds the staves/systems on each page and the blank rows where a page can safely be cut, then packs whole systems onto screens (see Resizing)
- `js/readers/` – **format readers**. `index.js` documents the interface and holds the registry (add `<script>` tags in index.html and sw.js for new files); `pdf-reader.js` (pdf.js 3.11 classic build, vendored in `vendor/pdfjs`; v3 is used because newer pdf.js is ES-module-only and won't load from file://), `image-reader.js` (png/jpg/webp). Add a format = new file + one line in `READERS`.
- `js/input/midi.js` – Web MIDI device manager (selectable inputs)
- `js/input/bindings.js` – action bindings + "Learn"; defaults: soft pedal (CC67) = next page, sostenuto pedal (CC66) = previous page
- `js/settings-ui.js` – ⚙ dialog: pick MIDI inputs, learn pedals/keys, live MIDI monitor
- `sw.js` – offline app-shell cache (bump `VERSION` when files change)

## Folders
One level deep. Open a folder to see its pieces as an ordered list: reorder with the ▲▼ buttons or by dragging the ⋮⋮ grip. Move a piece with 📂 (or drag it onto a folder card, or onto the "Music Library" crumb to take it out). Adding music while a folder is open appends to that folder. Deleting a folder sends it, with its pieces, to the trash.
In the viewer, ⏮/⏭ (or `[` / `]`, or MIDI actions "Previous/Next piece in folder" once learned) jump to the neighbouring piece. Setting: page-turn past the last page can continue into the next piece automatically (off by default).

## Adding a whole folder
"+ Add folder" (in Chrome/Edge this opens the browser's folder-only chooser; other browsers fall back to their generic upload dialog, which cannot be limited to folders – anything but PDFs/images is ignored either way; or dragging a folder onto the page) creates a new library folder named after the source folder and imports its supported files (PDF, images) in natural file-name order ("2 …" before "10 …"). Only files directly inside the folder are imported; subfolders are skipped and reported. A name that already exists gets " (2)" etc. Dropping loose files adds them to the open folder as before. While a folder is open, "+ Add folder" instead adds every supported file in the chosen folder (including its subfolders, flattened) to the open folder, since folders are one level deep.

## Duplicate detection
Every piece stores a SHA-256 hash of its file bytes. On import, files whose hash matches something already in the library trigger a dialog that says how many copies already exist and where:
- **Only here** – the score ends up only in the destination: one placement is moved here (or kept, if one is already here) and it is removed from every other folder/set list. Its existing title is kept.
- **Only there** – leave everything as it is, skip the upload.
- **Both places** (**All places** when it already exists in several) – keep the existing placements and add one here, named after the imported file's name (same name → same title); the file is stored once.
Names are ignored when matching. The same file appearing twice in one import is skipped (same destination) or shared (different folders) automatically. Pieces added before this feature are hashed once in the background at startup. Only byte-identical files match; a re-saved or re-exported copy of the same score will not.

## Shared copies (one file, several places)
A piece record = one *placement* (title, folder, position, last page). Its `fileId` names the stored blob in the `files` store; copies made with 🔗 (or "Both places") are extra placements pointing at the same `fileId`, so the bytes are stored once. Like a hard link, the stored file is deleted only when its last placement is removed, so removing the "original" never breaks the others. Titles, play order and last page are independent per placement; cards show "🔗 also in …".

## Trash
The 🗑 button at the bottom left opens the trash; its badge counts **pieces** (a folder with 2 pieces plus a folder with 5 shows 7). Deleting is always one click with no confirmation, because everything can be put back:
- Deleting a piece (🗑 on it, or drag it onto the 🗑 icon) flags it `trashedAt`; the stored file is kept. This applies to shared copies too: just that placement goes to the trash.
- Deleting a folder trashes the folder and all its pieces together (`trashedAt` on the folder; its pieces get `trashedAt` + `trashedWithFolder` and keep their `folderId`/`order`).
In the trash, a deleted folder is one row (click to expand and see its pieces). Folder rows: **Put back** (restores the folder with everything, in its original order) and **Delete permanently**. Piece rows: click to preview, **Put back** (to its original folder, or the top level if that folder is gone), **Move to…** (any folder; also available for pieces inside a trashed folder) and **Delete permanently**. **Empty trash** deletes everything permanently after a confirmation. Permanent deletes always confirm. Nothing expires automatically. Trashed pieces are ignored by duplicate detection.

## Resizing
Zoom is relative to *fit width*, which is also the maximum size (the music is never wider than the window). Size changes in whole steps of one line of music (one system – treble and bass staves together): **+** shows one more line on the screen (smaller music) and **−** one line less (bigger music); the `+` / `-` keys do the same. A step is the largest size at which that many lines always fit, so the music is never shrunk without room for another line, and **+** stops once the whole piece fits on one screen (the steps are recomputed when the window is resized or headers/footers are hidden). The page icon between the buttons shows how much is on screen – three lines of text inside the page at the largest size (as few lines of music as possible), a single line when several lines of music are showing – and clicking it (or pressing `0`) makes the music as big as possible; click again, with no size change in between, to go back to the size you had. It is greyed out at the largest size. Zoom is remembered per piece.
The first time a piece is opened it is analysed once (a second or so; the result is cached): staff lines are located, staves are grouped into systems (using the barline at the left edge and the spacing between staves), and page cuts are only allowed in completely blank rows. Each screen then shows as many whole systems as fit, and a page turn advances one *screen* – across the original page boundaries – so a smaller zoom shows more music per turn and no staff is ever cut off. At small zooms, page headers/footers of the original pages appear in the middle of the stream. If a file can't be analysed, it falls back to one fitted page per turn.
Headers and footers: during analysis each block is tagged music / header / footer (no staves, above the first or below the last system of a page) / text (pages with no staves at all, e.g. a cover). The headers/footers button (a page icon with two blue bars, in the top-right corner of the sheet music on the first screen only) hides every header and footer so only music remains; the choice is remembered. Text-only pages before the first music or after the last (cover, copyright notice) count as header/footer too; text-only pages in the middle (lyric sheets) are never hidden. A header that sits too close to the music to be cut cleanly stays attached to it.
Not included: changing key or measures per line – that needs the notation itself (e.g. MusicXML), not a PDF picture.

## Annotating
Press **a** or tap the small triangle at the left end of the toolbar (not available for files that can't be analysed). Tools:
- **Fingering** – tap anywhere; type digits, `/` or `-` (e.g. `5/1`) or use the 1–5 / `/` / `-` buttons; Enter or ✓ adds. Tap an existing fingering to edit it; clear the box to delete it.
- **Highlight** – pick a colour and drag a box. Translucent (multiply-blended, so the notes stay black). Tap a highlight to remove it.
- **Note** – tap; a filled notehead sized from that staff's line spacing snaps to the nearest line or space (no stem, no ledger lines).
- **Erase** – drag. It paints white over the music **and then redraws the staff lines it covered**, so only the notes/stems/text go. Sizes S/M/L (S is smaller than the gap between two lines). It also removes any note or fingering you added under it. The original file is never modified.
- **Move** – every fingering, note and highlight gets a dashed orange outline and a ✛ badge. Drag one to move it (a note still snaps onto lines/spaces as you drag, and can be dropped on another system or page; a highlight moves whole, no resizing). Tap one to select it (solid blue): the toolbar then shows **◀ ▲ ▼ ▶** nudge buttons (hold to repeat) and **Delete**; the arrow keys nudge too (Shift = 5×) and Delete/Backspace deletes. One nudge = 1 screen pixel at the current zoom; a note's vertical nudge is half a staff space. Dragging and nudging happen in screen space, so an item slides smoothly from one system into the next with no sticky spot; its centre is always kept on the music (never in the blank space that is dropped between systems), and an item that was saved in such a gap is pulled back when the piece opens. A highlight dragged across a system boundary is re-split to follow the systems under it. A drag, or a run of nudges, is one undo step. Eraser strokes can be selected and moved, nudged or deleted too (click on or near the erased area; the dashed frame shows its extent): moving one moves the white patch, deleting it brings the erased music back.
- **The toolbar** starts collapsed: just a small triangle at its left end (annotating is off). Tap the triangle (or press `a`) to open it; once open, the triangle expands the toolbar to show the button names (▸) or collapses it to icons only (◂). It always re-opens exactly as you left it — names or not, same tool, colour and eraser size (remembered between visits too). These keys also work with the toolbar closed: pressing one opens the toolbar straight onto that tool (so `e` opens it with the eraser selected). With the toolbar open, **F** / **H** / **N** / **E** / **M** pick Fingering / Highlight / Note / Erase / Move. The fingering pointer is a box the size of one character. In Move, the four nudge arrows sit around the selected annotation (the toolbar keeps only Delete). The circled-✕ **Close** button (or `a` / Esc) collapses it again and turns annotating off. The toolbar button with the screen-and-bar icon opens a small menu to dock the toolbar at the bottom, left, top or right edge (remembered). It is always a single row (a single column on the sides; it scrolls if the window is too narrow), sits flush against its edge, and in icons-only mode carries no text — hover for tooltips. Docked at the bottom the page counter moves to the right corner; docked at the top the filename is hidden and the bar stays clear of the zoom buttons.
- **Undo** (button or ⌘Z). Esc steps back: closes the dock menu or an open fingering box, then deselects, then collapses the toolbar and leaves annotating. While annotating, tap/swipe paging is off; keys and pedals still turn pages.
Annotations are stored in page coordinates per stored file (so zooming, hiding headers and re-packing never move them, and shared copies show the same markings). The staff positions come from the layout analysis (stored in `layout.staves`), which is why older cached layouts are re-analysed once.

## Controls
Keyboard: → ↓ Space PageDown next; ← ↑ PageUp previous; ] / [ or ⌘→ / ⌘← next/previous piece; + / - zoom, 0 fit width; Esc goes up one level (music → folder → library; trash → library; nothing at the top). Tap left third / rest of page, or swipe.

**Developer note:** `index.html` loads the scripts as `…js?v=N` and `sw.js` has `VERSION = 'mb-vN'`; bump both together when you change code, so a normal reload picks up the new files (Chrome can otherwise reuse cached scripts from `file://`).

**Eraser:** it only removes notes — barlines and the clef / key / time signature at the start of each staff are protected (found by the layout analysis, so older layouts are re-analysed once). It is heuristic: a note right after the time signature may be partly protected, and key/time changes mid-system aren't protected.

MIDI bindings cover only page and piece turning (next/previous page, next/previous piece); zoom and headers/footers have no MIDI actions. In ⚙ settings each action has a **?** button showing its keyboard shortcuts.

**Reload:** what is open is remembered (`mb-session` in localStorage). After a reload the same piece reopens at the same place and zoom (kept per piece), with the annotation toolbar open or closed as it was and the same tool selected. Closing the music (× or Esc) clears it, so the library shows next time.

**Library rows:** inside a folder each row reads: drag handle, ▲/▼ (stacked, reorder), number, thumbnail, title, then the buttons – rename, a separator, copy (circled +: shares the same file into another folder), move (circled arrow) and delete. The grid view uses the same button order.

**Where settings live:** the play order of a folder and what is open (piece, annotation toolbar state) are kept in the browser database (small `meta:` records), not only in localStorage, because some setups (e.g. opening the page from a `file://` path) don't keep localStorage between loads. Reordering no longer rewrites the piece records.

## Versioning and build

`python3 tools/build.py` (the same scheme as the study app) stamps the version before you copy, commit or push. The footer shows `VERSION` (the number in the `VERSION` file, e.g. 1.0; change it by hand for a bigger release) plus a short fingerprint of the sources, e.g. `1.0 (build 3f3510c)`. The same fingerprint becomes the `?v=` number on every script and stylesheet in `index.html` and the offline cache name in `sw.js`, so browsers and installed copies pick up changes. Run it after every change; running it again without changes alters nothing. There is nothing to bundle: the app runs straight from the files, from `file://` or published from the repository root with GitHub Pages.

## Icons

`icons/icon.svg` is the source (blue tile, staff, white note, like the Music Theory app). `python3 tools/make-icons.py` (needs `rsvg-convert`) makes the PNGs used for the iPad/iPhone home screen (`apple-touch-icon`) and the installable-app manifest; run it after changing the SVG, then `tools/build.py`.
