// Vanilla JavaScript — no framework, no build step. Progressive enhancement over the
// static HTML: the page works without JS; this just adds the year and an interactive demo.
(function () {
  'use strict';

  // Footer year.
  var yearEl = document.getElementById('year');
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }

  // Demo counter — proves JS is wired and interactive. Replace with your own app.
  var btn = document.getElementById('counter');
  if (btn) {
    var count = 0;
    btn.addEventListener('click', function () {
      count += 1;
      btn.textContent = 'Clicked ' + count + (count === 1 ? ' time' : ' times');
    });
  }
})();
