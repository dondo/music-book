(function () {
'use strict';
const { ACTIONS, describeSignature } = MB;
// Settings dialog: choose MIDI input devices, bind pedals/keys to page turns.


class SettingsUI {
  constructor(dialog, midi, bindings) {
    this.dialog = dialog;
    this.midi = midi;
    this.bindings = bindings;
    this.learningAction = null;
    this.lastMsg = null;

    dialog.querySelector('.settings-close').addEventListener('click', () => this.close());
    dialog.addEventListener('close', () => this._stopLearning());
    midi.onDevices(() => { if (dialog.open) this.render(); });
    bindings.onMonitor((m, press) => {
      this.lastMsg = { m, press };
      if (dialog.open) this._renderMonitor();
    });
  }

  open() { this.render(); this.dialog.showModal(); }
  close() { this.dialog.close(); }

  _stopLearning() {
    this.learningAction = null;
    this.bindings.cancelLearn();
  }

  render() {
    const body = this.dialog.querySelector('.settings-body');
    body.replaceChildren();

    // --- MIDI devices ---
    const h1 = el('h3', {}, 'MIDI input');
    body.append(h1);

    if (!this.midi.supported || this.midi.error) {
      body.append(el('p', { class: 'warn' }, this.midi.error || 'Web MIDI is not available in this browser.'));
    } else {
      const devices = this.midi.deviceList();
      if (!devices.length) {
        body.append(el('p', { class: 'muted' }, 'No MIDI devices found. Connect your keyboard or pedal and it will appear here.'));
      }
      const all = this.bindings.settings.midiInputs === null;
      const allRow = el('label', { class: 'row' });
      const allBox = el('input', { type: 'checkbox' });
      allBox.checked = all;
      allBox.addEventListener('change', () => {
        this.bindings.setMidiInputs(allBox.checked ? null : devices.map(d => d.id));
        this.render();
      });
      allRow.append(allBox, el('span', {}, 'Listen to all devices'));
      body.append(allRow);

      for (const d of devices) {
        const row = el('label', { class: 'row indent' + (all ? ' disabled' : '') });
        const box = el('input', { type: 'checkbox' });
        box.checked = d.active;
        box.disabled = all;
        box.addEventListener('change', () => {
          const cur = new Set((this.bindings.settings.midiInputs || []));
          box.checked ? cur.add(d.id) : cur.delete(d.id);
          this.bindings.setMidiInputs([...cur]);
        });
        row.append(box, el('span', {}, d.name + (d.connected ? '' : ' (disconnected)')));
        body.append(row);
      }
    }

    // --- Bindings ---
    body.append(el('h3', {}, 'Page-turn controls'));
    body.append(el('p', { class: 'muted' }, 'Press “Learn”, then press the pedal or key you want to use. A pedal counts as pressed when it goes past halfway down.'));

    for (const a of ACTIONS) {
      const row = el('div', { class: 'binding' });
      row.append(el('div', { class: 'binding-label' }, a.label));
      const chips = el('div', { class: 'chips' });
      for (const sig of this.bindings.bindingsFor(a.id)) {
        const chip = el('span', { class: 'chip' }, describeSignature(sig));
        const x = el('button', { class: 'chip-x', title: 'Remove', type: 'button' }, '×');
        x.addEventListener('click', () => { this.bindings.remove(a.id, sig); this.render(); });
        chip.append(x);
        chips.append(chip);
      }
      if (!chips.children.length) chips.append(el('span', { class: 'muted' }, 'none'));
      row.append(chips);

      const learn = el('button', { type: 'button', class: 'learn' }, this.learningAction === a.id ? 'Press a pedal or key…' : 'Learn');
      if (this.learningAction === a.id) learn.classList.add('active');
      learn.disabled = !this.midi.supported || !!this.midi.error;
      learn.addEventListener('click', async () => {
        if (this.learningAction === a.id) { this._stopLearning(); this.render(); return; }
        this.learningAction = a.id;
        this.render();
        const result = await this.bindings.learn(a.id);
        if (this.learningAction === a.id) this.learningAction = null;
        if (result !== null || this.dialog.open) this.render();
      });
      row.append(learn);
      body.append(row);
    }

    body.append(el('p', { class: 'muted' }, 'Keyboard: → ↓ Space PageDown = next, ← ↑ PageUp = previous, Esc = close. Tapping the page also turns it.'));

    // --- Live monitor ---
    body.append(el('h3', {}, 'Last MIDI message'));
    body.append(el('div', { class: 'monitor' }));
    this._renderMonitor();
  }

  _renderMonitor() {
    const box = this.dialog.querySelector('.monitor');
    if (!box) return;
    if (!this.lastMsg) { box.textContent = 'Nothing received yet.'; return; }
    const { m, press } = this.lastMsg;
    box.textContent = `${m.deviceName} · ch ${m.channel} · ${describeSignature(m)} · value ${m.value}${press ? ' · press' : ''}`;
  }
}

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
MB.SettingsUI = SettingsUI;
})();
