'use strict';
/* ---------------- 7. Health ---------------- */
builders.health = () => {
  const ciJob = (name, os, steps) =>
    h(
      'div',
      { style: 'margin:8px 0' },
      h(
        'div',
        { class: 'small' },
        h('b', null, name),
        ' ',
        os.map((o) => h('span', { class: 'pill', style: 'margin-left:4px' }, o)),
      ),
      h(
        'div',
        { class: 'pipe', style: 'margin-top:5px' },
        steps.flatMap((st, i) => [i ? h('span', { class: 'ar' }, '→') : null, h('span', { class: 'st' }, st)]),
      ),
    );
  return [
    h('h2', null, 'Tests, docs and CI'),
    h(
      'p',
      { class: 'lead' },
      'How well each part is checked. The main process has dense unit tests; the UI relies on end-to-end tests; CI runs the tests on Windows, Linux and macOS.',
    ),
    h(
      'div',
      { class: 'grid kpis' },
      h(
        'div',
        { class: 'card kpi' },
        h('div', { class: 'v' }, String(D.testsByArea.reduce((sum, t) => sum + t.c, 0))),
        h('div', { class: 'l' }, 'unit test cases'),
        h('div', { class: 's' }, `${D.testsByArea.reduce((sum, t) => sum + t.f, 0)} files, Vitest`),
      ),
      h(
        'div',
        { class: 'card kpi' },
        h('div', { class: 'v' }, String(D.e2e.reduce((sum, [, n]) => sum + n, 0))),
        h('div', { class: 'l' }, 'e2e cases'),
        h('div', { class: 's' }, `${D.e2e.length} files, Playwright + mock APIs`),
      ),
      h(
        'div',
        { class: 'card kpi' },
        h('div', { class: 'v' }, '12'),
        h('div', { class: 'l' }, 'benchmark tasks'),
        h('div', { class: 's' }, '5 small + 7 large, plus opt-in prompt cache and plan-mode suites'),
      ),
      h(
        'div',
        { class: 'card kpi' },
        h('div', { class: 'v' }, '10'),
        h('div', { class: 'l' }, 'perf cases'),
        h('div', { class: 's' }, '3 files, opt-in'),
      ),
      h(
        'div',
        { class: 'card kpi' },
        h('div', { class: 'v' }, '4'),
        h('div', { class: 'l' }, 'CI workflows'),
        h('div', { class: 's' }, 'ci, release, claude, code-review'),
      ),
    ),
    h(
      'div',
      { class: 'grid g2', style: 'margin-top:14px' },
      card(
        'Unit test cases per area',
        bars(D.testsByArea.map((t) => [t.a, t.c, t.c < 20 ? 'var(--bad)' : 'var(--good)'])),
      ),
      card('End-to-end cases per file', bars(D.e2e, { mono: true, color: 'var(--c-renderer)' })),
    ),
    h(
      'div',
      { class: 'grid g2', style: 'margin-top:14px' },
      card(
        'Big files without an adjacent test file',
        bars(
          D.untested.map(([n, f]) => [f, n, 'var(--bad)']),
          { mono: true },
        ),
        h(
          'p',
          { class: 'small muted', style: 'margin:6px 0 0' },
          `* files.ts has no file of its own but is tested in tools/tools.test.ts. ${D.untested.filter(([, f]) => f.startsWith('renderer/')).length} of these ${D.untested.length} are renderer views.`,
        ),
      ),
      card(
        'CI pipeline (.github/workflows)',
        ciJob('ci.yml: format', ['ubuntu'], ['npm ci', 'format:check']),
        ciJob('ci.yml: lint', ['ubuntu'], ['npm ci', 'lint']),
        ciJob('ci.yml: test', ['win', 'ubuntu', 'macos'], ['npm ci', 'typecheck', 'test:unit', 'test:e2e']),
        ciJob('ci.yml: package', ['ubuntu', 'macos'], ['build', 'electron-builder', 'smoke-test app', 'upload']),
        ciJob(
          'release.yml (tag v*, or dry run)',
          ['win', 'ubuntu', 'macos'],
          ['signing secrets', 'typecheck', 'test:unit', 'e2e', 'build + sign', 'SHA256SUMS', 'gh release'],
        ),
        h(
          'p',
          { class: 'small', style: 'margin:8px 0 0;color:var(--warn)' },
          'All three platforms run the tests. Ubuntu gives bwrap scoped AppArmor userns permission; restart tests wait for Local State only on Windows and use deterministic unreadable-key fixtures (#93). Windows sandbox tests use a mapped cwd and normalized ACL fixtures without relaxing isolation assertions.',
        ),
      ),
    ),
    h(
      'div',
      { class: 'grid g2', style: 'margin-top:14px' },
      card(
        'Docs (lines)',
        bars(D.docs, { mono: true, color: 'var(--c-shared)' }),
        h('p', { class: 'small muted', style: 'margin:6px 0 0' }, 'Plus 4 screenshots in docs/images.'),
      ),
      card(
        'Release bookkeeping',
        h(
          'ul',
          { class: 'small', style: 'margin:0;padding-left:18px' },
          h(
            'li',
            null,
            'License: ',
            h('code', null, D.license),
            '. Commercial and closed-source derivatives are allowed subject to license and notice requirements. Prior MIT grants and dependency licenses remain intact. Packaged builds include the license (with the preserved MIT notice) and the README.',
          ),
          h('li', null, 'package.json version: ', h('code', null, '0.1.0'), ' (the version of the first release)'),
          h('li', null, 'Git tags: v0.1.0, v0.1.1, v0.2.0, v0.3.0 (2026-09-29 to 09-30)'),
          h('li', null, `CHANGELOG has one heading, [Unreleased], with ${D.changelogEntries} entries`),
          h(
            'li',
            null,
            'release.yml checks the tag against package.json; tag v0.1.0 already exists on an old commit, so releasing 0.1.0 needs that tag moved or removed',
          ),
          h('li', null, 'tsconfig.node.tsbuildinfo, a build artifact, shows 16 changes in recent history'),
        ),
      ),
    ),
  ];
};
