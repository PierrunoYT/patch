'use strict';
/* ---------------- 2. Architecture map ---------------- */
builders.arch = () => {
  const pos = {
    renderer: [170, 70],
    views: [430, 70],
    preload: [690, 70],
    mainroot: [430, 230],
    agent: [120, 380],
    tools: [340, 380],
    llm: [560, 380],
    panels: [780, 380],
    search: [230, 520],
    storage: [450, 520],
    shared: [780, 520],
  };
  const W = 170,
    H = 62;
  const byId = Object.fromEntries(D.areas.map((a) => [a.id, a]));
  const detail = h('div', { class: 'card detail' });
  const svg = s('svg', { viewBox: '0 0 900 590', role: 'img', 'aria-label': 'Module map' });
  const defs = s(
    'defs',
    null,
    s(
      'marker',
      {
        id: 'ar',
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 7,
        markerHeight: 7,
        orient: 'auto-start-reverse',
      },
      s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--muted)' }),
    ),
  );
  svg.append(defs);
  // process bands
  const band = (y, hh, label, color) =>
    svg.append(
      s('rect', { x: 10, y, width: 880, height: hh, rx: 14, fill: color, opacity: 0.07 }),
      s('text', { x: 22, y: y + 18, 'font-size': 12, opacity: 0.7 }, label),
    );
  band(20, 110, 'RENDERER PROCESS (sandboxed)', 'var(--c-renderer)');
  band(170, 400, 'MAIN PROCESS (Node.js)', 'var(--c-main)');
  const edgeEls = [];
  const center = (id) => [pos[id][0], pos[id][1]];
  function addEdge(a, b, n, dashed, label) {
    const [x1, y1] = center(a),
      [x2, y2] = center(b);
    // shorten to box edges
    const dx = x2 - x1,
      dy = y2 - y1;
    const t1 = Math.min(Math.abs(W / 2 / (dx || 1e-9)), Math.abs(H / 2 / (dy || 1e-9)));
    const sx = x1 + dx * t1,
      sy = y1 + dy * t1,
      ex = x2 - dx * t1,
      ey = y2 - dy * t1;
    const curve =
      (a === 'tools' && b === 'agent') || (a === 'views' && b === 'renderer') || (a === 'llm' && b === 'mainroot')
        ? 22
        : 0;
    const mx = (sx + ex) / 2 - (dy / Math.hypot(dx, dy)) * curve,
      my = (sy + ey) / 2 + (dx / Math.hypot(dx, dy)) * curve;
    const p = s('path', {
      d: `M${sx},${sy} Q${mx},${my} ${ex},${ey}`,
      class: 'edge',
      'stroke-width': Math.max(1.2, Math.sqrt(n) * 1.3),
      'marker-end': 'url(#ar)',
      'stroke-dasharray': dashed ? '5 4' : null,
    });
    p.dataset.a = a;
    p.dataset.b = b;
    const t = s(
      'text',
      { x: mx, y: my - 3, 'font-size': 11, 'text-anchor': 'middle', opacity: 0.8 },
      label || String(n),
    );
    svg.append(p, t);
    edgeEls.push(p);
  }
  D.edges.forEach(([a, b, n]) => addEdge(a, b, n));
  addEdge('views', 'preload', 1, true, 'window.api');
  addEdge(
    'preload',
    'mainroot',
    1,
    true,
    `IPC ${D.ipc.invoke.reduce((sum, [, n]) => sum + n, 0)}+${D.ipc.events.length}`,
  );
  addEdge('mainroot', 'shared', D.sharedEdges.find(([area]) => area === 'mainroot')[1], false, '+ every area → shared');
  const nodes = {};
  for (const [id, [x, y]] of Object.entries(pos)) {
    const a = byId[id];
    const g = s(
      'g',
      { class: 'node', tabindex: 0, role: 'button', 'aria-label': a.label },
      s('rect', {
        x: x - W / 2,
        y: y - H / 2,
        width: W,
        height: H,
        rx: 10,
        fill: 'var(--panel)',
        stroke: procColor(a.proc),
        'stroke-width': 1.6,
      }),
      s('text', { x, y: y - 6, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 600 }, a.label),
      s(
        'text',
        { x, y: y + 14, 'text-anchor': 'middle', 'font-size': 11.5, opacity: 0.75 },
        `${a.files} files · ${fmt(a.lines)} lines`,
      ),
    );
    g.addEventListener('click', () => select(id));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(id);
      }
    });
    svg.append(g);
    nodes[id] = g;
  }
  function select(id) {
    const a = byId[id];
    Object.entries(nodes).forEach(([k, g]) => g.classList.toggle('sel', k === id));
    edgeEls.forEach((p) => {
      const on = p.dataset.a === id || p.dataset.b === id;
      p.classList.toggle('hl', on);
      p.classList.toggle('dim', !on);
    });
    const out = D.edges.filter((e) => e[0] === id).map((e) => `${byId[e[1]].label} (${e[2]})`);
    const inn = D.edges.filter((e) => e[1] === id).map((e) => `${byId[e[0]].label} (${e[2]})`);
    const sh = D.sharedEdges.find((e) => e[0] === id);
    detail.replaceChildren(
      h('h3', null, h('span', { class: 'pill', style: `border-color:${procColor(a.proc)}` }, a.proc), a.label),
      h('p', { class: 'small', style: 'margin:0 0 8px' }, a.desc),
      h(
        'div',
        { class: 'small' },
        h('b', null, fmt(a.lines)),
        ' source lines in ',
        h('b', null, a.files),
        ' files; ',
        h('b', null, a.tests),
        ' test files',
        a.testLines != null ? `; ${fmt(a.testLines)} test lines` : '',
      ),
      h(
        'div',
        { class: 'small', style: 'margin-top:6px' },
        h('b', null, 'Imports from: '),
        out.length ? out.join(', ') : 'none',
        sh ? `; shared (${sh[1]})` : '',
      ),
      h(
        'div',
        { class: 'small' },
        h('b', null, 'Imported by: '),
        inn.length ? inn.join(', ') : id === 'shared' ? 'every area (see Dependencies tab)' : 'none',
      ),
      id === 'agent' || id === 'tools'
        ? h(
            'div',
            { class: 'small', style: 'margin-top:6px;color:var(--warn)' },
            'Note: main/agent and main/tools import each other (a cycle: 7 edges one way, 1 back).',
          )
        : null,
      h(
        'div',
        { class: 'chips', style: 'margin-top:10px' },
        a.list.map((f) => h('span', { class: 'pill mono' }, f)),
      ),
    );
  }
  select('agent');
  return [
    h('h2', null, 'Architecture map'),
    h(
      'p',
      { class: 'lead' },
      'Boxes are folders; arrows are import statements between them (the number is how many). Dashed arrows go over IPC, not imports. Click a box for its files and connections.',
    ),
    h(
      'div',
      { class: 'legend' },
      ['renderer', 'preload', 'main', 'shared'].map((p) =>
        h('span', null, h('i', { style: `background:${procColor(p)}` }), p),
      ),
    ),
    h('div', { class: 'flowlay' }, h('div', { class: 'card svgwrap' }, svg), h('div', null, detail)),
  ];
};
