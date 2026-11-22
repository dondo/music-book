(function () {
'use strict';
// Web MIDI input manager (Chrome/Edge; needs https or localhost).
//
// Emits parsed messages:  { type: 'cc'|'note'|'pc', number, value, channel, deviceId, deviceName }
// - cc:   control change (pedals are CC 64 sustain, 66 sostenuto, 67 soft)
// - note: note-on with velocity > 0 (note-offs and velocity-0 are reported as value 0)
// - pc:   program change (some foot controllers send these)
//
// Which devices are listened to is selectable; `enabled === null` means "all inputs".

class MidiInput {
  constructor() {
    this.access = null;
    this.supported = typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
    this.enabled = null;            // null = all, otherwise array of device ids
    this.messageListeners = new Set();
    this.deviceListeners = new Set();
    this.error = null;
  }

  async init() {
    if (!this.supported) { this.error = 'Web MIDI is not available in this browser (use Chrome or Edge).'; return false; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.error = 'MIDI access was denied: ' + (e?.message || e);
      return false;
    }
    this.access.onstatechange = () => { this._attach(); this._notifyDevices(); };
    this._attach();
    this._notifyDevices();
    return true;
  }

  get inputs() {
    return this.access ? [...this.access.inputs.values()] : [];
  }

  deviceList() {
    return this.inputs.map(i => ({
      id: i.id,
      name: i.name || 'Unknown device',
      manufacturer: i.manufacturer || '',
      connected: i.state === 'connected',
      active: this.isActive(i.id),
    }));
  }

  isActive(id) {
    return this.enabled === null || this.enabled.includes(id);
  }

  setEnabled(ids) {            // ids: array or null (= all)
    this.enabled = ids;
    this._notifyDevices();
  }

  onMessage(fn) { this.messageListeners.add(fn); return () => this.messageListeners.delete(fn); }
  onDevices(fn) { this.deviceListeners.add(fn); return () => this.deviceListeners.delete(fn); }

  _notifyDevices() { for (const fn of this.deviceListeners) fn(this.deviceList()); }

  _attach() {
    for (const input of this.inputs) {
      if (input._mbAttached) continue;
      input._mbAttached = true;
      input.onmidimessage = ev => this._handle(input, ev);
    }
  }

  _handle(input, ev) {
    if (!this.isActive(input.id)) return;
    const [status, d1 = 0, d2 = 0] = ev.data;
    if (status >= 0xf0) return;                 // clock, active sensing, sysex...
    const kind = status & 0xf0;
    const channel = (status & 0x0f) + 1;
    let msg = null;
    if (kind === 0xb0) msg = { type: 'cc', number: d1, value: d2 };
    else if (kind === 0x90) msg = { type: 'note', number: d1, value: d2 };   // velocity 0 == note-off
    else if (kind === 0x80) msg = { type: 'note', number: d1, value: 0 };
    else if (kind === 0xc0) msg = { type: 'pc', number: d1, value: 127 };
    if (!msg) return;
    msg.channel = channel;
    msg.deviceId = input.id;
    msg.deviceName = input.name || '';
    for (const fn of this.messageListeners) fn(msg);
  }
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const CC_NAMES = { 64: 'Sustain pedal', 66: 'Sostenuto pedal', 67: 'Soft pedal', 68: 'Legato', 1: 'Mod wheel', 11: 'Expression' };

function describeSignature(sig) {
  if (sig.type === 'cc') return `${CC_NAMES[sig.number] || 'Controller'} (CC ${sig.number})`;
  if (sig.type === 'note') return `Key ${NOTE_NAMES[sig.number % 12]}${Math.floor(sig.number / 12) - 1} (note ${sig.number})`;
  if (sig.type === 'pc') return `Program change ${sig.number}`;
  return '?';
}
MB.MidiInput = MidiInput;
MB.describeSignature = describeSignature;
})();
