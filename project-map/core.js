'use strict';
/* ---------------- helpers ---------------- */
const $ = (s) => document.querySelector(s);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
  for (const k of kids.flat())
    if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const e = document.createElementNS(NS, tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
  for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
const fmt = (n) => n.toLocaleString('en-US');
const procColor = (p) => `var(--c-${p})`;
function bars(rows, opts = {}) {
  const max = opts.max || Math.max(...rows.map((r) => r[1]));
  return h(
    'div',
    { class: 'bars' },
    rows.map((r) =>
      h(
        'div',
        { class: 'row', title: r[0] + ': ' + r[1] },
        h('span', { class: 'lab' + (opts.mono ? ' mono' : '') }, r[0]),
        h(
          'span',
          { class: 'track' },
          h('span', {
            class: 'fill',
            style: `display:block;width:${((r[1] / max) * 100).toFixed(1)}%;background:${r[2] || opts.color || 'var(--accent)'}`,
          }),
        ),
        h('span', { class: 'val' }, opts.suffix ? fmt(r[1]) + opts.suffix : fmt(r[1])),
      ),
    ),
  );
}
function card(title, ...kids) {
  return h('div', { class: 'card' }, title ? h('h3', null, title) : null, ...kids);
}

/* ---------------- tabs ---------------- */
const TABS = [
  ['overview', 'Overview'],
  ['arch', 'Architecture map'],
  ['flow', 'One chat turn'],
  ['safety', 'Safety model'],
  ['size', 'Code size'],
  ['deps', 'Dependencies & IPC'],
  ['health', 'Tests, docs, CI'],
  ['issues', 'Issues board'],
  ['activity', 'Activity'],
  ['focus', 'Focus next'],
];
const builders = {};
function showTab(id) {
  for (const b of document.querySelectorAll('nav button'))
    b.setAttribute('aria-selected', b.dataset.id === id ? 'true' : 'false');
  for (const sec of document.querySelectorAll('section.tab')) sec.classList.toggle('on', sec.id === 'tab-' + id);
  try {
    localStorage.setItem('patchmap-tab', id);
  } catch {
    // Storage can be blocked (a private window); the page works without it.
  }
  window.scrollTo(0, 0);
}
