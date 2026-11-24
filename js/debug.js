(function () {
'use strict';
// A small on-screen log for problems that can't be seen from a desktop (e.g. in an iPad's embedded browser).
// Switch it on with ?debug in the address, or by tapping the version number in the footer five times; tapping the log itself five times switches it off.
const KEY = 'mb-debug';
let on = false, panel = null, lines = [];
try { on = /[?&]debug\b/.test(location.search) || localStorage.getItem(KEY) === '1' || window.name.includes('mb-debug=1'); } catch {}

function paint() {
  if (!on) { if (panel) { panel.remove(); panel = null; } return; }
  if (!panel) {
    panel = document.createElement('pre');
    panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;margin:0;padding:6px 8px;z-index:99999;' +
      'font:11px/1.35 ui-monospace,Menlo,monospace;color:#9ef;background:rgba(0,0,0,.82);white-space:pre-wrap;word-break:break-all;-webkit-user-select:none;user-select:none';
    panel.title = 'Tap 5 times to close';
    document.body.append(panel);
  }
  panel.textContent = lines.join('\n');
  panel.scrollTop = panel.scrollHeight;
}
function log(...a) {
  const s = a.map(x => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ');
  lines.push(new Date().toTimeString().slice(0, 8) + ' ' + s); if (lines.length > 60) lines.shift();
  if (on) paint();
}
function set(v) {
  on = v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch {}
  try { window.name = (window.name || '').replace(/mb-debug=1;?/g, '') + (v ? 'mb-debug=1;' : ''); } catch {}
  log(v ? 'debug on' : 'debug off'); paint();
}
window.addEventListener('error', e => log('ERROR', e.message, (e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', e => log('REJECTED', e.reason && (e.reason.stack || e.reason.message || String(e.reason)).slice(0, 300)));
const ce = console.error.bind(console); console.error = (...a) => { log('console.error', ...a); ce(...a); };
const cw = console.warn.bind(console); console.warn = (...a) => { log('console.warn', ...a); cw(...a); };
let taps = 0, tt = 0;
document.addEventListener('click', e => {
  if (!e.target.closest || !(e.target.closest('.foot-version') || (panel && panel.contains(e.target)))) return;
  const now = Date.now(); taps = now - tt < 1500 ? taps + 1 : 1; tt = now;
  if (taps >= 5) { taps = 0; set(!on); }
}, true);

// While debugging, trace every step of a touch on the zoom controls or the annotation toolbar (so the two can be compared).
const desc = t => !t || !t.tagName ? String(t) : t.tagName.toLowerCase() + (typeof t.className === 'string' && t.className ? '.' + t.className.split(' ')[0] : '');
['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click', 'lostpointercapture', 'gotpointercapture', 'dragstart', 'selectstart', 'contextmenu'].forEach(type => {
  document.addEventListener(type, e => {
    if (!on || !e.target.closest || !e.target.closest('.zoom, .ann-bar')) return;
    const t = e.touches && e.touches[0] || e.changedTouches && e.changedTouches[0] || e;
    const at = t.clientX != null ? document.elementFromPoint(t.clientX, t.clientY) : null;
    log('·' + type, desc(e.target), e.pointerType || '', 'at', desc(at), e.defaultPrevented ? 'prevented' : '');
  }, true);
});
MB.debug = log; MB.debugOn = () => on;
if (on) document.addEventListener('DOMContentLoaded', paint);
})();
