(function () {
'use strict';
// A small on-screen log for problems that can't be seen from a desktop (e.g. in an iPad's embedded browser).
// Switch it on with ?debug in the address, or by tapping the version number in the footer five times; tapping the log five times switches it off.
const KEY = 'mb-debug';
let on = false, panel = null, lines = [];
try { on = /[?&]debug\b/.test(location.search) || localStorage.getItem(KEY) === '1' || window.name.includes('mb-debug=1'); } catch {}
function paint() {
  if (!on) { if (panel) { panel.remove(); panel = null; } return; }
  if (!panel) {
    panel = document.createElement('pre');
    panel.style.cssText = 'position:fixed;left:0;right:0;bottom:0;max-height:38vh;overflow:auto;margin:0;padding:6px 8px;z-index:99999;' +
      'font:11px/1.35 ui-monospace,Menlo,monospace;color:#9ef;background:rgba(0,0,0,.82);white-space:pre-wrap;word-break:break-all;-webkit-user-select:none;user-select:none';
    document.body.append(panel);
  }
  panel.textContent = lines.join('\n'); panel.scrollTop = panel.scrollHeight;
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
let taps = 0, tt = 0;
document.addEventListener('click', e => {
  if (!e.target.closest || !(e.target.closest('.foot-version') || (panel && panel.contains(e.target)))) return;
  const now = Date.now(); taps = now - tt < 1500 ? taps + 1 : 1; tt = now;
  if (taps >= 5) { taps = 0; set(!on); }
}, true);
// Where a touch lands, against where things are drawn (for the annotation tools).
document.addEventListener('pointerdown', e => {
  if (!on || !e.target.closest || !e.target.closest('.ann-layer')) return;
  const r = el => { const b = el && el.getBoundingClientRect(); return b ? [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)] : null; };
  const vv = window.visualViewport;
  log('touch', { client: [Math.round(e.clientX), Math.round(e.clientY)], page: [Math.round(e.pageX), Math.round(e.pageY)], screen: [Math.round(e.screenX), Math.round(e.screenY)],
    layer: r(document.querySelector('.ann-layer')), view: r(MB.viewer && MB.viewer.view), root: r(document.getElementById('viewer')),
    win: [innerWidth, innerHeight, outerWidth, outerHeight], vv: vv && [Math.round(vv.offsetLeft), Math.round(vv.offsetTop), vv.scale, Math.round(vv.width), Math.round(vv.height)],
    scroll: [Math.round(scrollX), Math.round(scrollY)], dpr: devicePixelRatio });
}, true);
if (on) document.addEventListener('DOMContentLoaded', paint);
MB.debug = log;
})();
