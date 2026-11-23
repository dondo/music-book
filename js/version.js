/* the version shown in the footer (kept in step with the ?v= number in index.html and VERSION in sw.js) */
(function () {
  var APP_VERSION = '54';
  function show() { Array.prototype.forEach.call(document.querySelectorAll('[data-version]'), function (e) { e.textContent = APP_VERSION; }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
