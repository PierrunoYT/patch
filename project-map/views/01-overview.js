'use strict';
/* ---------------- 1. Overview ---------------- */
builders.overview = () => {
  const totalSrc = D.areas.reduce((a, x) => a + x.lines, 0) + RENDERER_CSS_LINES;
  const k = (v, l, sub) =>
    h(
      'div',
      { class: 'card kpi' },
      h('div', { class: 'v' }, v),
      h('div', { class: 'l' }, l),
      sub ? h('div', { class: 's' }, sub) : null,
    );
  const proc = (name, color, lines, what) =>
    h(
      'div',
      { class: 'layer', style: `border-left-color:${color}` },
      h('div', null, h('b', null, name), h('div', { class: 'small muted' }, fmt(lines) + ' source lines')),
      h('div', { class: 'small' }, what),
    );
  return [
    h('h2', null, 'Patch in one screen'),
    h(
      'p',
      { class: 'lead' },
      'Patch is an Electron desktop app: a chat window (renderer) talks through a thin typed bridge (preload) to a Node process (main) that runs the AI agent loop, the tools and the provider clients. Code shared by both sides lives in shared/. Use the tabs above to drill down one layer at a time.',
    ),
    h(
      'div',
      { class: 'grid kpis' },
      k(fmt(totalSrc), 'source lines', '87 TS files + renderer CSS'),
      k(
        fmt(D.testsByArea.reduce((sum, testArea) => sum + testArea.tl, 0)),
        'unit-test lines',
        `${D.testsByArea.reduce((sum, testArea) => sum + testArea.f, 0)} files, ${D.testsByArea.reduce((sum, testArea) => sum + testArea.c, 0)} cases`,
      ),
      k(String(D.e2e.reduce((a, [, n]) => a + n, 0)), 'end-to-end cases', `${D.e2e.length} Playwright files`),
      k(String(D.tools.length), 'built-in tools', '+ MCP tools, 3 subagents among them'),
      k(
        `${D.ipc.invoke.reduce((sum, [, n]) => sum + n, 0)} / ${D.ipc.events.length}`,
        'IPC invoke / event channels',
        `${Object.values(D.chatEvents).flat().length} chat event types`,
      ),
      k(
        String(Object.values(D.models).flat().length),
        `models, ${Object.keys(D.models).length} providers`,
        'Anthropic + OpenAI',
      ),
      k(
        String(D.issues.length),
        'open issues',
        ['high', 'medium', 'low'].map((s) => `${D.issues.filter((i) => i[3] === s).length} ${s}`).join(', '),
      ),
      k(
        String(D.commitsByDay.reduce((sum, [, n]) => sum + n, 0)),
        'commits',
        `${D.commitsByDay.filter(([d]) => d >= '2026-09-29').reduce((sum, [, n]) => sum + n, 0)} of them since 2026-09-29`,
      ),
    ),
    h(
      'div',
      { class: 'grid g2', style: 'margin-top:14px' },
      card(
        'The four layers',
        h(
          'div',
          { class: 'layers' },
          proc(
            'renderer',
            procColor('renderer'),
            procLines('renderer') + RENDERER_CSS_LINES,
            `Sandboxed UI (no Node). App, transcript, composer, panels, dialogs. Largest layer, includes ${fmt(RENDERER_CSS_LINES)} lines of CSS.`,
          ),
          proc(
            'preload',
            procColor('preload'),
            procLines('preload'),
            `Exposes only invoke/on for allow-listed channels. ${D.ipc.invoke.reduce((sum, [, n]) => sum + n, 0)} invoke + ${D.ipc.events.length} event channels.`,
          ),
          proc(
            'main',
            procColor('main'),
            procLines('main'),
            `Agent loop, provider clients, ${D.tools.length} tools, command sandboxes, MCP, panel back ends, storage and IPC handlers.`,
          ),
          proc(
            'shared',
            procColor('shared'),
            procLines('shared'),
            'IPC contract, chat events, models, settings. Imported by every layer.',
          ),
        ),
      ),
      card(
        'Where things stand',
        h(
          'ul',
          { style: 'margin:0;padding-left:18px' },
          h(
            'li',
            null,
            h('b', null, 'Main process is well tested: '),
            'agent, llm, tools and panels all have more test lines than source lines.',
          ),
          h(
            'li',
            null,
            h('b', null, 'Renderer is barely unit-tested: '),
            '6343 source lines (CSS included) vs 138 test lines; its 4 biggest files have no test file (e2e covers some of it).',
          ),
          h(
            'li',
            null,
            h('b', null, 'Security is the largest issue theme: '),
            `${D.issues.filter((issue) => issue[2] === 'security').length} of ${D.issues.length} open issues, none of them high since #63 was fixed. Windows sandbox reliability is the main active cluster.`,
          ),
          h(
            'li',
            null,
            h('b', null, 'CI tests all three platforms, with one Windows flake left: '),
            'Windows, Linux and macOS run the tests and packaged apps are smoke-tested. #54 is fixed; #50 still times out intermittently.',
          ),
          h(
            'li',
            null,
            h('b', null, "Release isn't ready: "),
            'package.json is 0.1.0, but old tags v0.1.0 to v0.3.0 already exist, the CHANGELOG only has [Unreleased], and Windows signing is waiting on a certificate (#26).',
          ),
        ),
        h(
          'div',
          { class: 'callout', style: 'margin-top:12px' },
          'Short answer: agent commands are sandboxed with read-only Git metadata, and the Oct 5–6 security reviews found no critical issue. Protective-rule confirmations (#114), HTML-only Markdown (#115) and chat errors kept out of logs (#116) are fixed. Overlapping Windows commands keep .git protected (#100), and protected toolchains such as the official Node are copied once, not per command (#108). Next, #101 once Node bundles libuv 1.53, and the remaining review finding (#112). See',
          h(
            'a',
            {
              href: '#',
              onclick: (e) => {
                e.preventDefault();
                showTab('focus');
              },
            },
            'Focus next',
          ),
          ' for the ranked list.',
        ),
      ),
    ),
  ];
};
