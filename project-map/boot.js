'use strict';
/* ---------------- boot ---------------- */
const nav = $('#tabs'),
  mainEl = $('#main');
for (const [id, label] of TABS) {
  nav.append(h('button', { type: 'button', role: 'tab', 'data-id': id, onclick: () => showTab(id) }, label));
  const sec = h('section', { class: 'tab', id: 'tab-' + id });
  try {
    sec.append(...builders[id]());
  } catch (err) {
    sec.append(h('p', null, 'Could not draw this view: ' + err.message));
    console.error(err);
  }
  mainEl.append(sec);
}
let start = 'overview';
try {
  const t = localStorage.getItem('patchmap-tab');
  if (t && builders[t]) start = t;
} catch {
  // Storage can be blocked (a private window); the page works without it.
}
showTab(start);

const themes = ['auto', 'light', 'dark'];
let ti = 0;
try {
  ti = Math.max(0, themes.indexOf(localStorage.getItem('patchmap-theme') || 'auto'));
} catch {
  // Storage can be blocked (a private window); the page works without it.
}
function applyTheme() {
  const t = themes[ti];
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  $('#themeBtn').textContent = 'Theme: ' + t;
  try {
    localStorage.setItem('patchmap-theme', t);
  } catch {
    // Storage can be blocked (a private window); the page works without it.
  }
}
$('#themeBtn').addEventListener('click', () => {
  ti = (ti + 1) % 3;
  applyTheme();
});
applyTheme();
