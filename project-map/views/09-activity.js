'use strict';
/* ---------------- 9. Activity ---------------- */
builders.activity = () => {
  const maxD = Math.max(...D.commitsByDay.map((d) => d[1]));
  return [
    h('h2', null, 'Recent activity'),
    h(
      'p',
      { class: 'lead' },
      `${D.commitsByDay.reduce((a, d) => a + d[1], 0)} commits in total. Apart from 3 commits on 2024-07-29, all of them landed from 2026-09-29 to ${D.commitsByDay.at(-1)[0]}. The project is moving fast, which is part of why it feels big.`,
    ),
    h(
      'div',
      { class: 'grid g2' },
      card(
        'Commits per day',
        h(
          'div',
          { class: 'mini' },
          D.commitsByDay.map(([d, n]) =>
            h(
              'div',
              { class: 'b' },
              h('div', null, n),
              h('div', { class: 'bar', style: `height:${(n / maxD) * 120}px` }),
              h('div', { class: 't' }, d),
            ),
          ),
        ),
      ),
      card(
        'Commit types (Conventional Commits)',
        bars(
          D.types.map(([t, n]) => [
            t,
            n,
            t === 'fix'
              ? 'var(--bad)'
              : t === 'feat'
                ? 'var(--good)'
                : t === 'docs'
                  ? 'var(--c-shared)'
                  : 'var(--accent)',
          ]),
        ),
      ),
    ),
    h(
      'div',
      { class: 'grid g2', style: 'margin-top:14px' },
      card(
        'Most-changed files, last 60 days',
        bars(
          D.churn.map(([f, n]) => [f, n, f.startsWith('src/') ? 'var(--c-main)' : 'var(--c-ext)']),
          { mono: true },
        ),
        h(
          'div',
          { class: 'legend' },
          h('span', null, h('i', { style: 'background:var(--c-main)' }), 'source'),
          h('span', null, h('i', { style: 'background:var(--c-ext)' }), 'docs, config, build'),
        ),
      ),
      h(
        'div',
        { class: 'grid', style: 'align-content:start' },
        card('Authors', bars(D.authors, { color: 'var(--c-renderer)' })),
        card(
          '15 most recent commits, merges left out (2026-10-05 to 10-06)',
          h(
            'div',
            { class: 'tablewrap' },
            h(
              'table',
              null,
              h(
                'tbody',
                null,
                D.recent.map(([c, m]) =>
                  h('tr', null, h('td', { class: 'mono muted' }, c), h('td', { class: 'small' }, m)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ];
};
