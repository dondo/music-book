(function () {
'use strict';
// Appearance: 'dark' (the default), 'light', or 'auto' (follow the device). Kept in localStorage for an instant first paint and in the
// database too, because localStorage isn't dependable everywhere (e.g. some file:// setups).
const KEY = 'mb-theme', root = document.documentElement;
const META = { dark: '#1b1d21', light: '#f3f4f7' };
let current = 'dark', changedAt = 0;
try { changedAt = Number(localStorage.getItem('mb-theme-u')) || 0; } catch {}
try { const t = localStorage.getItem(KEY); if (t === 'light' || t === 'auto') current = t; } catch {}

function apply(t) {
  current = t === 'light' || t === 'auto' ? t : 'dark';
  if (current === 'dark') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', current);
  const light = current === 'light' || (current === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.setAttribute('content', light ? META.light : META.dark);
}
function setTheme(t, at) {
  apply(t);
  const fromSync = at != null;
  changedAt = fromSync ? at : Date.now();
  try { localStorage.setItem('mb-theme-u', String(changedAt)); } catch {}
  MB.putMeta('themeu', changedAt).catch(() => {});
  if (!fromSync) MB.notifyChange?.('settings');
  try { current === 'dark' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, current); } catch {}
  (current === 'dark' ? MB.deleteMeta('theme') : MB.putMeta('theme', current)).catch(() => {});
}
apply(current);
if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (current === 'auto') apply('auto'); });
// where localStorage kept nothing, the database may still know
MB.getMeta('theme').then(t => { if (t && t !== current) apply(t); }).catch(() => {});
MB.getMeta('themeu').then(u => { if (u && u > changedAt) changedAt = u; }).catch(() => {});

MB.getTheme = () => current;
MB.setTheme = t => setTheme(t);
MB.applyTheme = (t, at) => setTheme(t, at);          // from sync: keeps the other device's time and doesn't start another sync
MB.getThemeU = () => changedAt;
})();
