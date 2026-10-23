'use strict';
/* ---------------- 6. Dependencies & IPC ---------------- */
builders.deps = () => {
  const byId = Object.fromEntries(D.areas.map((a) => [a.id, a]));
  // adjacency matrix
  const ids = [
    'renderer',
    'views',
    'preload',
    'mainroot',
    'agent',
    'llm',
    'tools',
    'panels',
    'search',
    'storage',
    'shared',
  ];
  const m = {};
  D.edges.forEach(([a, b, n]) => {
    m[a + '>' + b] = n;
  });
  D.sharedEdges.forEach(([a, n]) => {
    m[a + '>shared'] = n;
  });
  const max = 16;
  const matrix = h(
    'table',
    { style: 'font-size:12px' },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', null, 'from ↓ / to →'),
        ids.map((i) =>
          h(
            'th',
            { class: 'n', style: 'writing-mode:vertical-rl;transform:rotate(180deg);height:90px' },
            byId[i].label,
          ),
        ),
      ),
    ),
    h(
      'tbody',
      null,
      ids.map((a) =>
        h(
          'tr',
          null,
          h('th', null, byId[a].label),
          ids.map((b) => {
            const n = m[a + '>' + b];
            return h(
              'td',
              {
                class: 'n',
                title: n ? `${byId[a].label} → ${byId[b].label}: ${n}` : '',
                style: n
                  ? `background:color-mix(in srgb,var(--accent) ${Math.round(15 + (n / max) * 70)}%,transparent);color:${n > 8 ? '#fff' : 'inherit'}`
                  : '',
              },
              n || '',
            );
          }),
        ),
      ),
    ),
  );
  const evGroups = Object.entries(D.chatEvents);
  return [
    h('h2', null, 'Dependencies & IPC'),
    h(
      'p',
      { class: 'lead' },
      'How the parts talk. Inside a process they import each other (matrix). Across processes they only talk over named IPC channels, and the agent reports progress to the UI as chat events.',
    ),
    h(
      'div',
      { class: 'grid g2' },
      card(
        'Import matrix (import statements, non-test files)',
        h('div', { class: 'tablewrap' }, matrix),
        h(
          'p',
          { class: 'small muted', style: 'margin:8px 0 0' },
          `Darker = more imports. shared is imported by every area, most of all by main (root) with ${D.sharedEdges.find(([area]) => area === 'mainroot')[1]} and renderer/views with ${D.sharedEdges.find(([area]) => area === 'views')[1]}. Inside shared, ipc.ts imports chat, panels, project and settings.`,
        ),
      ),
      h(
        'div',
        { class: 'grid', style: 'align-content:start' },
        card(
          `${D.ipc.invoke.reduce((sum, [, n]) => sum + n, 0)} IPC invoke channels, by prefix`,
          bars(
            D.ipc.invoke.map(([p, n]) => [p + ':', n]),
            { mono: true, color: 'var(--c-preload)' },
          ),
          h(
            'details',
            null,
            h('summary', { class: 'small' }, 'Show channel names'),
            h(
              'div',
              { class: 'small' },
              D.ipc.invoke.map(([p]) => h('div', null, h('b', { class: 'mono' }, p + ': '), D.ipc.invokeNames[p])),
            ),
          ),
        ),
        card(
          `${D.ipc.events.length} event channels (main → renderer)`,
          h(
            'div',
            { class: 'chips' },
            D.ipc.events.map((e) => h('span', { class: 'pill mono' }, e)),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'grid g2', style: 'margin-top:14px' },
      card(
        `${Object.values(D.chatEvents).flat().length} chat event types (shared/chat.ts)`,
        h(
          'div',
          { class: 'layers' },
          evGroups.map(([g, list]) =>
            h(
              'div',
              { class: 'layer', style: 'border-left-color:var(--c-shared)' },
              h('b', null, `${g} (${list.length})`),
              h(
                'div',
                { class: 'chips' },
                list.map((e) => h('span', { class: 'pill mono' }, e)),
              ),
            ),
          ),
        ),
        h(
          'p',
          { class: 'small muted', style: 'margin:8px 0 0' },
          'Transcript items have 5 kinds (user, assistant, tool, error, notice); a tool card has 5 states (awaiting-approval, running, done, error, declined).',
        ),
      ),
      card(
        'Providers, models and packages',
        h(
          'div',
          { class: 'small' },
          h('b', null, 'Anthropic'),
          ' (Messages API, anthropic.ts): ',
          D.models.anthropic.join(', '),
        ),
        h(
          'div',
          { class: 'small', style: 'margin-top:4px' },
          h('b', null, 'OpenAI'),
          ' (Responses API, openai_responses.ts): ',
          D.models.openai.join(', '),
        ),
        h(
          'div',
          { class: 'small', style: 'margin-top:4px' },
          h('b', null, 'Custom OpenAI-compatible endpoints'),
          ' use Chat Completions (openai.ts). Claude can also go through a proxy or gateway (Settings, Claude base URL, confirmed natively because the key goes to that host).',
        ),
        h(
          'div',
          { class: 'small', style: 'margin-top:4px' },
          'Code search: Voyage voyage-code-4 embeddings and rerank-3 reranking, both through OpenRouter.',
        ),
        h('hr', { style: 'border:0;border-top:1px solid var(--line);margin:12px 0' }),
        bars(
          [
            ['dependencies', D.npmDeps],
            ['devDependencies', D.npmDev],
          ],
          { color: 'var(--c-ext)' },
        ),
        h(
          'p',
          { class: 'small muted', style: 'margin:6px 0 0' },
          'Runtime dependencies: @anthropic-ai/sdk, openai, zod, node-pty, simple-git, diff, ignore, linkedom, @mozilla/readability. Renderer libraries (marked, DOMPurify, highlight.js, xterm, bootstrap…) and the MCP SDK client (@modelcontextprotocol/sdk) are devDependencies because Vite bundles them.',
        ),
      ),
    ),
  ];
};
