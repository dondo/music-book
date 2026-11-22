(function () {
'use strict';
const { pdfReader, imageReader } = MB;
// Format reader registry.
//
// A reader teaches the app how to open one kind of file. To add a format
// (MusicXML, MIDI-to-notation, multi-image albums, ...), write a module that
// registers an object of this shape on MB (e.g. MB.myReader = {...}) and add it
// to READERS below. Scripts are plain <script> tags so the app runs from file://.
//
//   {
//     id: 'pdf',                         // stored with each library record
//     name: 'PDF',
//     extensions: ['pdf'],               // lower-case, no dot
//     mimeTypes: ['application/pdf'],
//     async open(blob) -> Doc
//   }
//
//   Doc = {
//     pageCount: number,
//     async renderPage(pageNumber /* 1-based */, canvas, { maxWidth, maxHeight, dpr }),
//         // draw the page scaled to FIT inside maxWidth x maxHeight CSS pixels;
//         // size canvas.width/height (device px) and canvas.style (CSS px) yourself
//     async thumbnail(maxSize) -> Blob,  // small JPEG of page 1 for the library
//     destroy(),                         // release resources
//   }


const READERS = [pdfReader, imageReader];

function readerById(id) {
  return READERS.find(r => r.id === id) || null;
}

function readerForFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return READERS.find(r => r.extensions.includes(ext) || r.mimeTypes.includes(file.type)) || null;
}

function supportedExtensions() {
  return READERS.flatMap(r => r.extensions.map(e => '.' + e));
}

function supportedNames() {
  return READERS.map(r => r.name).join(', ');
}
MB.readerById = readerById;
MB.readerForFile = readerForFile;
MB.supportedExtensions = supportedExtensions;
MB.supportedNames = supportedNames;
})();
