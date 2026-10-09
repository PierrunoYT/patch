'use strict';
/* ---------------- 4. Safety ---------------- */
builders.safety = () => {
  const layer = (name, color, what, where) =>
    h(
      'div',
      { class: 'layer', style: `border-left-color:${color}` },
      h('div', null, h('b', null, name), h('div', { class: 'small muted mono' }, where)),
      h('div', { class: 'small' }, what),
    );
  return [
    h('h2', null, 'Safety model'),
    h(
      'p',
      { class: 'lead' },
      'Patch lets a model edit files and run commands, so most of the design is about limits. These are the layers a tool call passes through, from the outside in.',
    ),
    h(
      'div',
      { class: 'grid g2' },
      card(
        'Layers of protection',
        h(
          'div',
          { class: 'layers' },
          layer(
            'Sandboxed renderer',
            'var(--c-renderer)',
            'contextIsolation + sandbox, no Node, strict CSP, no navigation. DOM built with h(); HTML only from DOMPurify-sanitized markdown/diff.',
            'window.ts, dom.ts, markdown.ts',
          ),
          layer(
            'IPC allow-list',
            'var(--c-preload)',
            `Only ${D.ipc.invoke.reduce((sum, [, n]) => sum + n, 0)} invoke + ${D.ipc.events.length} event channels; a missing channel is a compile error. Only the app page's top frame is answered.`,
            'preload/index.ts, shared/ipc.ts, main/ipc.ts',
          ),
          layer(
            'Permission rules',
            'var(--c-main)',
            'User rules: allow / reject / ask / delegate (external program, 15 s timeout). First match wins; overrides alwaysAsk. Rules see project-relative paths, every file a patch touches and each part of a command; the strictest answer wins (#237).',
            'agent/permissions.ts',
          ),
          layer(
            'Approval modes',
            'var(--c-main)',
            'Ask (default) or Auto (needs a native confirm). requiresApproval asks in Ask mode; alwaysAsk (MCP, propose_plan) asks always; mustAsk per call.',
            'tools/types.ts, settings_confirm.ts',
          ),
          layer(
            'Allow-lists',
            'var(--c-main)',
            'Commands: whole-word prefix, refused if it contains ; & | < > ` $ ( ) { } or a newline, or an argument that writes a file or runs a program (--output, -o, find -exec …, #233). Network: exact hostname.',
            'allowed_commands.ts, allowed_network_hosts.ts',
          ),
          layer(
            'Protected files',
            'var(--warn)',
            'Case-insensitive protected names and canonical Windows aliases ask even in Auto; a failed safety check asks too (#143). AGENTS.md, CLAUDE.md, .patch skills, .mcp.json, .envrc and .husky are protected too (#236).',
            'tools/guard.ts',
          ),
          layer(
            'Workspace confinement',
            'var(--c-shared)',
            'Workspace.resolve checks paths; file reads, edits, patch mutations and Undo use native no-follow handles. Linked targets and hard-linked writes are refused (#144). Commands refuse sensitive project roots (#145).',
            'tools/workspace.ts, file_operations.ts, sandbox.ts; native/sandbox-helper/src/file_ops/',
          ),
          layer(
            'Secret redaction',
            'var(--c-shared)',
            'PEM keys, AWS / GitHub / OpenAI / Anthropic / Slack / Google keys, JWTs, passwords in connection-string URLs and password-like values are replaced before the model sees them, also before long output is shortened and while command output streams (#253).',
            'tools/redact.ts',
          ),
          layer(
            'Packaging',
            'var(--c-ext)',
            'Only out/main, out/preload and out/renderer ship; mutable logs and scratch files are excluded. Electron fuses: RUN_AS_NODE, NODE_OPTIONS and --inspect disabled; asar integrity. Git panel uses a hardened config.',
            'package.json, panels/git.ts',
          ),
        ),
      ),
      h(
        'div',
        { class: 'grid', style: 'align-content:start' },
        card(
          'Does this tool call need approval?',
          h(
            'div',
            { class: 'dec' },
            h('div', { class: 'q' }, '1. Input fails schema validation? → returned as an error, nothing runs'),
            h('div', { class: 'arrow' }, '↓ valid'),
            h('div', { class: 'q' }, '2. Permission rule rejects? → blocked; mustAsk safety check? → ask'),
            h('div', { class: 'arrow' }, '↓ neither'),
            h(
              'div',
              { class: 'q' },
              '3. Rule allows/asks? → follow it; otherwise alwaysAsk (MCP, propose_plan)? → ask',
            ),
            h('div', { class: 'arrow' }, '↓ no'),
            h('div', { class: 'q' }, '4. requiresApproval and mode is Ask and not on an allow-list? → ask'),
            h('div', { class: 'arrow' }, '↓ otherwise'),
            h('div', { class: 'q', style: 'border-color:var(--good)' }, 'Run it'),
          ),
        ),
        card(
          'Tools and their approval flags',
          h(
            'div',
            { class: 'tablewrap' },
            h(
              'table',
              null,
              h('thead', null, h('tr', null, h('th', null, 'Tool'), h('th', null, 'Asks'), h('th', null, 'Offered'))),
              h(
                'tbody',
                null,
                D.tools.map((t) =>
                  h(
                    'tr',
                    null,
                    h(
                      'td',
                      { class: 'mono' },
                      t[0],
                      D.readOnly.includes(t[0])
                        ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'subagents')
                        : null,
                    ),
                    h(
                      'td',
                      null,
                      t[3]
                        ? h('span', { class: 'pill sev-high' }, 'always')
                        : t[2]
                          ? h('span', { class: 'pill sev-medium' }, 'in Ask mode')
                          : h('span', { class: 'pill' }, 'no'),
                    ),
                    h('td', { class: 'small muted' }, t[4]),
                  ),
                ),
              ),
            ),
          ),
          h(
            'p',
            { class: 'small muted', style: 'margin:8px 0 0' },
            `"subagents" marks the ${D.readOnly.length} read-only tools that task, finder and oracle get. Subagents can't ask for approval and run at most 25 turns.`,
          ),
        ),
        card(
          'Security issues still open',
          h(
            'div',
            { class: 'small' },
            `${D.issues.filter((i) => i[2] === 'security' || i[2] === 'sandbox').length} open issues are about security or the command sandbox, ${D.issues.filter((i) => (i[2] === 'security' || i[2] === 'sandbox') && i[3] === 'high').length} of them high severity. Agent commands are sandboxed; macOS and Windows follow-ups are open. See the Issues board.`,
          ),
        ),
      ),
    ),
  ];
};
