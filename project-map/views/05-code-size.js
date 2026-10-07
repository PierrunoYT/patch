'use strict';
/* ---------------- 5. Code size ---------------- */
builders.size = () => {
  // Built from the area data, so the map always matches the other tabs. The renderer's few test lines are not
  // split by folder, so its cells (CSS included) share one ratio.
  const renderer = D.testsByArea.find((t) => t.a === 'renderer');
  const rendererRatio = renderer.tl / renderer.src;
  const cells = [
    ...D.areas.map((a) => ({
      n: a.label,
      v: a.lines,
      p: a.proc,
      r: a.proc === 'renderer' ? rendererRatio : a.lines ? (a.testLines ?? 0) / a.lines : 0,
    })),
    { n: 'renderer CSS', v: RENDERER_CSS_LINES, p: 'renderer', r: rendererRatio },
  ].sort((a, b) => b.v - a.v);
  const total = cells.reduce((a, c) => a + c.v, 0);
  const Wd = 1600,
    Ht = 900;
  function worst(row, side) {
    const sum = row.reduce((a, r) => a + r.a, 0);
    const mx = Math.max(...row.map((r) => r.a)),
      mn = Math.min(...row.map((r) => r.a));
    return Math.max((side * side * mx) / (sum * sum), (sum * sum) / (side * side * mn));
  }
  function squarify(items) {
    let rect = { x: 0, y: 0, w: Wd, h: Ht };
    let rest = items.map((i) => ({ ...i, a: (i.v / total) * Wd * Ht }));
    const out = [];
    while (rest.length) {
      const side = Math.min(rect.w, rect.h);
      const row = [rest[0]];
      let i = 1;
      while (i < rest.length && worst(row.concat(rest[i]), side) <= worst(row, side)) {
        row.push(rest[i]);
        i++;
      }
      rest = rest.slice(i);
      const sum = row.reduce((a, r) => a + r.a, 0);
      if (rect.w >= rect.h) {
        const cw = sum / rect.h;
        let y = rect.y;
        row.forEach((r) => {
          const rh = r.a / cw;
          out.push({ ...r, x: rect.x, y, w: cw, h: rh });
          y += rh;
        });
        rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
      } else {
        const rh = sum / rect.w;
        let x = rect.x;
        row.forEach((r) => {
          const rw = r.a / rh;
          out.push({ ...r, x, y: rect.y, w: rw, h: rh });
          x += rw;
        });
        rect = { x: rect.x, y: rect.y + rh, w: rect.w, h: rect.h - rh };
      }
    }
    return out;
  }
  const laid = squarify(cells);
  const tm = h('div', { class: 'treemap' });
  let mode = 'proc';
  const ratioColor = (r) => (r >= 1 ? 'var(--good)' : r >= 0.5 ? 'var(--warn)' : 'var(--bad)');
  function paint() {
    tm.replaceChildren(
      ...laid.map((c) =>
        h(
          'div',
          {
            class: 'tm',
            title: `${c.n}: ${fmt(c.v)} lines`,
            style: `left:${(c.x / Wd) * 100}%;top:${(c.y / Ht) * 100}%;width:${(c.w / Wd) * 100}%;height:${(c.h / Ht) * 100}%;background:${mode === 'proc' ? procColor(c.p) : ratioColor(c.r)}`,
          },
          h('b', null, c.n),
          fmt(c.v) + ' lines',
          mode === 'tests' && c.w > 160 ? h('div', null, `test/source ${c.r.toFixed(2)}`) : null,
        ),
      ),
    );
  }
  paint();
  const segBtns = [
    ['proc', 'Color by process'],
    ['tests', 'Color by test coverage'],
  ].map(([m, l]) =>
    h(
      'button',
      {
        type: 'button',
        class: m === mode ? 'on' : '',
        onclick: (e) => {
          mode = m;
          for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target);
          paint();
          legend.replaceChildren(...legendKids());
        },
      },
      l,
    ),
  );
  const legendKids = () =>
    mode === 'proc'
      ? ['renderer', 'main', 'shared', 'preload'].map((p) =>
          h('span', null, h('i', { style: `background:${procColor(p)}` }), p),
        )
      : [
          h('span', null, h('i', { style: 'background:var(--good)' }), 'test lines ≥ source lines'),
          h('span', null, h('i', { style: 'background:var(--warn)' }), '0.5 to 1'),
          h('span', null, h('i', { style: 'background:var(--bad)' }), 'under 0.5'),
        ];
  const legend = h('div', { class: 'legend' }, legendKids());
  const untested = new Set(D.untested.map((u) => u[1].replace(' *', '')));
  return [
    h('h2', null, 'Code size'),
    h(
      'p',
      { class: 'lead' },
      `Each rectangle's area is its share of the ${fmt(total)} source lines. Switch the color to see where unit tests are thin. (The 3 renderer cells share the renderer ratio.)`,
    ),
    h('div', { class: 'seg' }, segBtns),
    legend,
    h('div', { class: 'card' }, tm),
    h(
      'div',
      { class: 'grid g2', style: 'margin-top:14px' },
      card(
        'Source vs unit-test lines per area',
        h(
          'div',
          { class: 'tablewrap' },
          h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'Area'),
                h('th', { class: 'n' }, 'Source'),
                h('th', { class: 'n' }, 'Tests'),
                h('th', { class: 'n' }, 'Ratio'),
              ),
            ),
            h(
              'tbody',
              null,
              D.testsByArea.map((t) =>
                h(
                  'tr',
                  null,
                  h('td', null, t.a),
                  h('td', { class: 'n' }, fmt(t.src)),
                  h('td', { class: 'n' }, fmt(t.tl)),
                  h(
                    'td',
                    { class: 'n', style: `color:${ratioColor(t.src ? t.tl / t.src : 0)}` },
                    (t.src ? t.tl / t.src : 0).toFixed(2),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      card(
        '15 largest source files',
        bars(
          D.largest.map(([n, f]) => [f, n, untested.has(f) ? 'var(--bad)' : 'var(--c-main)']),
          { mono: true },
        ),
        h(
          'div',
          { class: 'legend' },
          h('span', null, h('i', { style: 'background:var(--bad)' }), 'no adjacent test file'),
          h('span', null, h('i', { style: 'background:var(--c-main)' }), 'has a test file'),
        ),
      ),
    ),
  ];
};
