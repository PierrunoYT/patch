'use strict';
/* ---------------- 3. One chat turn ---------------- */
builders.flow = () => {
  const lanes = ['Renderer', 'Preload', 'Main / ChatManager', 'Session & Agent', 'Provider', 'Tools', 'Storage'];
  const steps = [
    [0, 'Send', 'App.send() invokes chat:send', 'src/renderer/src/app.ts'],
    [
      1,
      'Bridge',
      'api.invoke checks the channel against INVOKE_CHANNELS, then ipcRenderer.invoke',
      'src/preload/index.ts',
    ],
    [
      2,
      'Handler',
      "handle('chat:send') returns at once; progress comes back as events. Only the app page's top frame is answered.",
      'src/main/index.ts, src/main/ipc.ts',
    ],
    [
      2,
      'ChatManager.send',
      'Rejects if busy or images unsupported. On the first message createSession() builds Workspace, shell, conversation, system prompt (with a project map stored with the chat), tool list (registry + MCP in name order + task/finder/oracle/todo) and the approval callbacks.',
      'src/main/chat_manager.ts',
    ],
    [
      3,
      'ChatSession.send',
      'Emits user event, starts title generation on the small model, prefixes undo notes, emits busy:true. With Settings, Prompt cache on, an idle Claude chat is kept warm by a cache-read request about every 4 minutes.',
      'src/main/agent/session.ts',
    ],
    [
      3,
      'Agent.run',
      'addUserMessage, immediate checkpoint save, then loop up to MAX_TURNS = 200. Tools are rebuilt every turn.',
      'src/main/agent/agent.ts',
    ],
    [
      4,
      'Stream a turn',
      'runTurnWithRetries → conversation.runTurn: assistant-start, assistant-delta, thinking-delta. Clients use maxRetries: 0; the agent retries itself (4 retries, ~2/4/8/16 s).',
      'src/main/llm/anthropic.ts, openai_responses.ts, openai.ts; agent/retry.ts',
    ],
    [
      3,
      'Turn ends',
      'assistant-end + usage. The assistant turn is recorded only on success. No tool calls → done.',
      'src/main/agent/agent.ts',
    ],
    [
      3,
      'Plan tool calls',
      "The latest app plan-mode note (user message or tool result) applies until superseded, including across screenshots. In plan mode propose_plan runs first; consecutive parallelSafe calls run together; truncated responses don't run tools.",
      'Agent.runTools',
    ],
    [
      5,
      'Validate + permission',
      'Zod schema check → decidePermission (rules) → needsApproval (alwaysAsk, mustAsk, requiresApproval in Ask mode, allow-lists).',
      'agent.ts, agent/permissions.ts',
    ],
    [
      0,
      'Approve?',
      'tool-start {awaitingApproval} shows a preview (diff / command / URL). User answers via chat:decide.',
      'ChatSession.waitForApproval / decide',
    ],
    [
      5,
      'Run tool',
      'tool.run with workspace, shell, browser, signal; tool-progress events; secrets redacted from output; tool-end. Edits recorded for undo.',
      'src/main/tools/*, tools/redact.ts, edit_backups.ts',
    ],
    [3, 'Loop', 'addToolResults (all together), checkpoint save, back to "Stream a turn".', 'agent.ts'],
    [
      2,
      'Events out',
      'Each event updates the main-side transcript (applyChatEvent), then is sent as chat:event.',
      'session.ts → index.ts',
    ],
    [
      0,
      'Render',
      'Events are queued and flushed per animation frame into TranscriptView.',
      'app.ts, views/transcript.ts',
    ],
    [
      6,
      'Save',
      'Debounced 500 ms (immediate on checkpoints and busy:false). Atomic JSON write to userData/chats/<id>.json, then history:changed. A checkpoint writes only the chat file, in the background.',
      'chat_store.ts, storage/json_file.ts',
    ],
  ];
  const top = 40,
    RH = 46,
    left = 10,
    colW = 118;
  const width = left + lanes.length * colW + 10,
    height = top + steps.length * RH + 20;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Chat turn swimlane' });
  svg.append(
    s(
      'defs',
      null,
      s(
        'marker',
        {
          id: 'ar2',
          viewBox: '0 0 10 10',
          refX: 9,
          refY: 5,
          markerWidth: 6,
          markerHeight: 6,
          orient: 'auto-start-reverse',
        },
        s('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--muted)' }),
      ),
    ),
  );
  const laneColors = [
    'var(--c-renderer)',
    'var(--c-preload)',
    'var(--c-main)',
    'var(--c-main)',
    'var(--c-ext)',
    'var(--c-shared)',
    'var(--c-ext)',
  ];
  lanes.forEach((l, i) => {
    svg.append(
      s('rect', {
        x: left + i * colW + 2,
        y: 4,
        width: colW - 4,
        height: height - 8,
        rx: 8,
        fill: laneColors[i],
        opacity: 0.06,
      }),
    );
    svg.append(
      s(
        'text',
        { x: left + i * colW + colW / 2, y: 24, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 600 },
        l,
      ),
    );
  });
  const detail = h('div', { class: 'card detail flowdetail' });
  const boxes = [];
  const cx = (i) => left + steps[i][0] * colW + colW / 2,
    cy = (i) => top + i * RH + RH / 2;
  for (let i = 0; i < steps.length - 1; i++) {
    svg.append(
      s('path', {
        d: `M${cx(i)},${cy(i) + 15} L${cx(i + 1)},${cy(i + 1) - 15}`,
        class: 'edge',
        'stroke-width': 1.4,
        'marker-end': 'url(#ar2)',
      }),
    );
  }
  // loop back arrow from step 12 to step 6
  const lx = left + 3 * colW + colW - 6;
  svg.append(
    s('path', {
      d: `M${cx(12) + 48},${cy(12)} C${lx + 40},${cy(12)} ${lx + 40},${cy(6)} ${cx(6) + 52},${cy(6)}`,
      class: 'edge',
      'stroke-width': 1.6,
      'stroke-dasharray': '5 4',
      'marker-end': 'url(#ar2)',
      style: 'stroke:var(--accent);opacity:.9',
    }),
  );
  svg.append(
    s(
      'text',
      {
        x: lx + 46,
        y: (cy(6) + cy(12)) / 2,
        'font-size': 11,
        fill: 'var(--accent)',
        'text-anchor': 'middle',
        transform: `rotate(90 ${lx + 46} ${(cy(6) + cy(12)) / 2})`,
      },
      'repeat ≤ 200 turns',
    ),
  );
  steps.forEach((st, i) => {
    const g = s(
      'g',
      { class: 'node', tabindex: 0, role: 'button' },
      s('rect', {
        x: cx(i) - 54,
        y: cy(i) - 15,
        width: 108,
        height: 30,
        rx: 8,
        fill: 'var(--panel)',
        stroke: laneColors[st[0]],
        'stroke-width': 1.5,
      }),
      s('text', { x: cx(i), y: cy(i) + 4, 'text-anchor': 'middle', 'font-size': 11 }, `${i + 1}. ${st[1]}`),
    );
    const pick = () => {
      boxes.forEach((b) => b.classList.remove('sel'));
      g.classList.add('sel');
      detail.replaceChildren(
        h('h3', null, h('span', { class: 'pill' }, `Step ${i + 1} of ${steps.length}`), st[1]),
        h('div', { class: 'small muted' }, lanes[st[0]]),
        h('p', { class: 'small' }, st[2]),
        h(
          'div',
          { class: 'chips' },
          st[3].split(/;|, /).map((f) => h('span', { class: 'pill mono' }, f.trim())),
        ),
      );
    };
    g.addEventListener('click', pick);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick();
      }
    });
    boxes.push(g);
    svg.append(g);
  });
  boxes[0].dispatchEvent(new Event('click'));
  return [
    h('h2', null, 'What happens in one chat turn'),
    h(
      'p',
      { class: 'lead' },
      'Read top to bottom. Each column is a part of the app; each box is a step. The dashed blue arrow is the agent loop: steps 7 to 13 repeat while the model keeps asking for tools. Click a step for detail and file names. Patch-owned agent flow. Claude Code models use ClaudeCodeAgent through createAgent instead: query/resume, Claude tools, permission callbacks and shared chat events.',
    ),
    h(
      'div',
      { class: 'flowlay' },
      h('div', { class: 'card svgwrap' }, svg),
      h(
        'div',
        null,
        detail,
        card(
          'Limits that bound a turn',
          bars(
            [
              ['agent turns (MAX_TURNS)', 200],
              ['subagent turns', 25],
              ['pause_turn continuations', 5],
              ['provider retries', 4],
              ['bad tool-input re-asks', 2],
            ],
            { color: 'var(--c-main)' },
          ),
        ),
        card(
          'Compaction (manual, chat:compact)',
          h(
            'p',
            { class: 'small', style: 'margin:0' },
            'A small model summarizes the head of the chat. Stored messages are never changed; only the request is built from summary + messages after keepFrom. The last ~40,000 characters are always kept. The UI suggests compacting at 150,000 tokens.',
          ),
        ),
        card(
          'Claude Code chats (claude-code/ models)',
          h(
            'p',
            { class: 'small', style: 'margin:0' },
            '/compact runs in Claude Code’s own resumed session, so its history is externally owned. MCP tools, leaving plan mode and sandbox-disabled Bash always ask for approval, even in Auto mode. Patch’s Undo, secret redaction and prompt-cache keep-alive do not apply to these tools.',
          ),
        ),
      ),
    ),
  ];
};
