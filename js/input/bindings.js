(function () {
'use strict';
// Maps input (MIDI messages, keyboard) to actions, and persists the settings.
//
// A binding "signature" is { type, number } (channel and device are ignored so a
// pedal works whichever port it arrives on). Several signatures can map to one
// action. "Learn" waits for the next MIDI message and records its signature.

const KEY = 'music-book.settings.v1';

const ACTIONS = [
  { id: 'next', label: 'Next page', hint: '→ ↓ Space PageDown, or tap the right side of the page' },
  { id: 'prev', label: 'Previous page', hint: '← ↑ PageUp, or tap the left side of the page' },
  { id: 'nextPiece', label: 'Next piece in folder', hint: '] or ⌘→' },
  { id: 'prevPiece', label: 'Previous piece in folder', hint: '[ or ⌘←' },
];

const DEFAULTS = {
  hideExtras: false,                       // hide page headers/footers (page numbers, copyright lines...)
  autoAdvance: false,                      // turning past the last page continues into the next piece
  midiInputs: null,                        // null = all devices, else [deviceId...]
  midiBindings: {
    next: [{ type: 'cc', number: 67 }],    // soft pedal
    prev: [{ type: 'cc', number: 66 }],    // sostenuto pedal
    nextPiece: [],                         // unbound until you Learn them
    prevPiece: [],
  },
};

// Settings that are kept in step across devices (the MIDI input choice is left out: device ids differ from one device to the next).
// `u` is the time of the last change to any of them.
const proj = s => JSON.stringify([!!s.autoAdvance, !!s.hideExtras, s.midiBindings]);
let lastProj = '';

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw) {
      const s = { ...DEFAULTS, ...raw, midiBindings: { ...DEFAULTS.midiBindings, ...(raw.midiBindings || {}) } };
      // bindings still at the old defaults (sustain = next, soft = previous) move to the new ones; anything you changed is kept
      const only = (a, n) => Array.isArray(a) && a.length === 1 && a[0].type === 'cc' && a[0].number === n;
      if (only(raw.midiBindings?.next, 64) && only(raw.midiBindings?.prev, 67)) { s.midiBindings.next = DEFAULTS.midiBindings.next; s.midiBindings.prev = DEFAULTS.midiBindings.prev; }
      for (const k of Object.keys(s.midiBindings)) if (!(k in DEFAULTS.midiBindings)) delete s.midiBindings[k];   // actions that no longer exist (zoom, headers/footers)
      lastProj = proj(s);
      return s;
    }
  } catch {}
  const d = structuredClone(DEFAULTS); lastProj = proj(d);
  return d;
}

function saveSettings(s, fromSync = false) {
  const p = proj(s);
  if (!fromSync && p !== lastProj) { s.u = Date.now(); MB.notifyChange?.('settings'); }      // something that is synced changed
  lastProj = p;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

const same = (a, b) => a.type === b.type && a.number === b.number;

class Bindings {
  constructor(midi, settings) {
    this.midi = midi;
    this.settings = settings;
    this.handlers = new Map();      // action id -> fn
    this.learning = null;           // { action, resolve }
    this.down = new Map();          // 'type:number' -> bool, for rising-edge detection
    this.monitorListeners = new Set();
    midi.onMessage(m => this._onMidi(m));
  }

  setHandler(action, fn) { this.handlers.set(action, fn); }
  clearHandlers() { this.handlers.clear(); }
  onMonitor(fn) { this.monitorListeners.add(fn); return () => this.monitorListeners.delete(fn); }

  bindingsFor(action) { return this.settings.midiBindings[action] || []; }

  add(action, sig) {
    const list = this.settings.midiBindings[action] = this.settings.midiBindings[action] || [];
    // a signature belongs to one action only
    for (const a of Object.keys(this.settings.midiBindings)) {
      this.settings.midiBindings[a] = this.settings.midiBindings[a].filter(s => !same(s, sig));
    }
    this.settings.midiBindings[action].push({ type: sig.type, number: sig.number });
    saveSettings(this.settings);
  }

  remove(action, sig) {
    this.settings.midiBindings[action] = this.bindingsFor(action).filter(s => !same(s, sig));
    saveSettings(this.settings);
  }

  setMidiInputs(ids) {
    this.settings.midiInputs = ids;
    this.midi.setEnabled(ids);
    saveSettings(this.settings);
  }

  // Wait for the next pedal press / key press and bind it to `action`.
  learn(action) {
    this.cancelLearn();
    return new Promise(resolve => { this.learning = { action, resolve }; });
  }

  cancelLearn() {
    if (this.learning) { this.learning.resolve(null); this.learning = null; }
  }

  // A press is: CC crossing up through 64, a note-on, or a program change.
  _isPress(m) {
    const k = m.type + ':' + m.number;
    if (m.type === 'cc') {
      const was = this.down.get(k) || false;
      const now = m.value >= 64;
      this.down.set(k, now);
      return now && !was;
    }
    if (m.type === 'note') return m.value > 0;
    return true;
  }

  _onMidi(m) {
    const press = this._isPress(m);
    for (const fn of this.monitorListeners) fn(m, press);
    if (!press) return;

    if (this.learning) {
      const { action, resolve } = this.learning;
      this.learning = null;
      this.add(action, m);
      resolve({ type: m.type, number: m.number });
      return;
    }
    for (const a of ACTIONS) {
      if (this.bindingsFor(a.id).some(s => same(s, m))) {
        this.handlers.get(a.id)?.();
        return;
      }
    }
  }
}
MB.ACTIONS = ACTIONS;
MB.loadSettings = loadSettings;
MB.saveSettings = saveSettings;
MB.Bindings = Bindings;
})();
