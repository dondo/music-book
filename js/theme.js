(function () {
'use strict';
// Appearance: 'dark' (the default), 'light', or 'auto' (follow the device). Kept in localStorage for an instant first paint and in the
// database too, because localStorage isn't dependable everywhere (e.g. some file:// setups).
const KEY = 'mb-theme', root = document.documentElement;
const META = { dark: '#1b1d21', light: '#f3f4f7' };
let current = 'dark';
try { const t = localStorage.getItem(KEY); if (t === 'light' || t === 'auto') current = t; } catch {}

function apply(t) {
  current = t === 'light' || t === 'auto' ? t : 'dark';
  if (current === 'dark') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', current);
  const light = current === 'light' || (current === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.setAttribute('content', light ? META.light : META.dark);
}
function setTheme(t) {
  apply(t);
  try { current === 'dark' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, current); } catch {}
  (current === 'dark' ? MB.deleteMeta('theme') : MB.putMeta('theme', current)).catch(() => {});
}
apply(current);
if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (current === 'auto') apply('auto'); });
// where localStorage kept nothing, the database may still know
MB.getMeta('theme').then(t => { if (t && t !== current) apply(t); }).catch(() => {});

MB.getTheme = () => current;
MB.setTheme = setTheme;
})();
