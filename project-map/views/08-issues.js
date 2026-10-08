'use strict';
/* ---------------- 8. Issues ---------------- */
builders.issues = () => {
  let filter = 'all';
  const board = h('div', { class: 'board' });
  const sevCount = { high: 0, medium: 0, low: 0 };
  D.issues.forEach((i) => sevCount[i[3]]++);
  function paint() {
    const themes = Object.keys(D.themes)
      .map((t) => [t, D.issues.filter((i) => i[2] === t && (filter === 'all' || i[3] === filter))])
      .filter(([, l]) => l.length);
    const order = { high: 0, medium: 1, low: 2 };
    board.replaceChildren(
      ...themes
        .sort((a, b) => b[1].length - a[1].length)
        .map(([t, list]) =>
          h(
            'div',
            { class: 'col' },
            h('h4', null, h('span', null, D.themes[t]), h('span', { class: 'pill' }, list.length)),
            list
              .sort((a, b) => order[a[3]] - order[b[3]])
              .map((i) =>
                h(
                  'div',
                  { class: 'icard ' + i[3] },
                  h(
                    'a',
                    {
                      href: `https://github.com/PierrunoYT/patch/issues/${i[0]}`,
                      target: '_blank',
                      rel: 'noopener',
                    },
                    '#' + i[0],
                  ),
                  ' ',
                  i[1],
                  h(
                    'div',
                    { class: 'meta' },
                    h('span', { class: 'pill sev-' + i[3] }, i[3] + (i[4] ? ' (est.)' : '')),
                    ' opened ',
                    i[5],
                  ),
                ),
              ),
          ),
        ),
    );
  }
  paint();
  const seg = h(
    'div',
    { class: 'seg' },
    [
      ['all', `All (${D.issues.length})`],
      ['high', `High (${sevCount.high})`],
      ['medium', `Medium (${sevCount.medium})`],
      ['low', `Low (${sevCount.low})`],
    ].map(([k, l]) =>
      h(
        'button',
        {
          type: 'button',
          class: k === filter ? 'on' : '',
          onclick: (e) => {
            filter = k;
            for (const b of seg.children) b.classList.toggle('on', b === e.target);
            paint();
          },
        },
        l,
      ),
    ),
  );
  const themeCounts = Object.keys(D.themes)
    .map((t) => [D.themes[t], D.issues.filter((i) => i[2] === t).length])
    .sort((a, b) => b[1] - a[1]);
  return [
    h('h2', null, 'Open issues board'),
    h(
      'p',
      { class: 'lead' },
      `${D.issues.length} open and ${D.closedCount} closed issues on GitHub. Most came from the Sep 30–Oct 3 audit, the Oct 4–5 sandbox, Electron and PR reviews, the Oct 6 and Oct 7 security reviews, and the Oct 7 code review. Columns are themes; the colored edge is severity. "(est.)" means the issue has no severity label and the severity is an estimate.`,
    ),
    h(
      'div',
      { class: 'grid g2' },
      card('Open issues by theme', bars(themeCounts, { color: 'var(--accent)' })),
      card(
        'Open issues by severity',
        bars([
          ['high', sevCount.high, 'var(--sev-high)'],
          ['medium', sevCount.medium, 'var(--sev-med)'],
          ['low', sevCount.low, 'var(--sev-low)'],
        ]),
        h(
          'p',
          { class: 'small muted', style: 'margin:6px 0 0' },
          `${sevCount.high} high, ${sevCount.medium} medium and ${sevCount.low} low. ` +
            (sevCount.high
              ? `High findings: ${D.issues
                  .filter((i) => i[3] === 'high')
                  .map((i) => '#' + i[0])
                  .join(', ')}.`
              : 'No high-severity findings remain in this snapshot; #143–#145 are fixed.'),
        ),
      ),
    ),
    seg,
    board,
  ];
};
