'use strict';
/* ---------------- 10. Focus ---------------- */
builders.focus = () => {
  const items = [
    [
      'Close the remaining Windows sandbox gaps: #101 and #108',
      'The command sandbox is the main control against a prompt-injected model. The #95 fix gives native commands a minimal environment, with native-confirmed extra variable and PATH settings. Root .git is read-only on every backend (#98), and Program Files toolchains such as the official Node now work in the AppContainer (#106). On macOS, Seatbelt Mach, shared-memory and sysctl access is limited to named entries, confirmed by real-Seatbelt probes on CI (#99).',
      [
        'Native environment isolation (#95) has unit and real-backend regression probes; Windows passes locally, while Linux/macOS probes require their native hosts',
        '#129 and #132 are fixed: non-Git folders get a .git reservation file Git refuses, and projects inside another repository get a protected empty HEAD folder, so a planted bare repository is never used. The Git panel refuses push/commit when repository config runs a project file (#130)',
        '#100 is fixed: overlapping helpers share the original .git inheritance snapshot and only the last run (or recovery) restores it; a real-helper test keeps writing .git/hooks while another run exits or is killed',
        '#101: npm startup and private temp/cache handling are fixed. Default node --test is blocked upstream: it needs libuv 1.53, which no Node release bundles yet. A Windows-sandbox timeout now tells the agent about the test-isolation=none workaround (passes real Windows tests) and the unsandboxed request. #108: official Node is copied for every command (~14 s); toolchain tests leave subst drives behind (#133)',
      ],
      'Project-drive crash recovery (#94) is complete. Prioritize #108, and re-check #101 when Node updates libuv; retain the metadata boundary while making narrower per-command path grants possible (#126).',
    ],
    [
      'Finish the Electron and tool hardening from the Oct 5–6 reviews',
      'The audits found no critical issue. All four high-priority findings are fixed: grep/glob patterns run in a worker (#122), connection-string passwords are redacted (#123), saved MCP headers cannot silently go to a new URL (#110), and Git panel Discard no longer deletes what a link points to (#111).',
      [
        '#112, #118: the synchronous .git validation before sandboxed commands and full chat saves still block the main process (sandbox program probes are asynchronous now)',
        '#114 is fixed: changes to protective rules or their ordered prefixes need native confirmation. #116 provider failure text kept out of local logs, #115 HTML-only Markdown and #113 MCP secret migration are also fixed',
        '#73: web_search still sends queries without approval',
        '#125: two transcript_view e2e tests fail intermittently in full runs',
        '#138: the crash_kill approval e2e test stalls intermittently on CI; asynchronous sandbox probes (#112) may fix it, to be confirmed over more runs',
      ],
      'The known protective-rule confirmation gap is closed (#114), including reorders that leave the protective rule at the same index. Continue with contained fixes and regression tests for the remaining findings.',
    ],
    [
      'Adopt narrower sandbox permissions and stronger file boundaries',
      'The Oct 6 comparison of Codex, Gemini CLI, Anthropic Sandbox Runtime and OpenHands found useful patterns without a reason to replace AppContainer. These are proposed enhancements, not claims of reproduced sandbox escapes.',
      [
        '#126: approve exact extra read/write paths for one command instead of dropping the sandbox',
        '#127: protect project-local agent, IDE and startup configuration from shell writes, including absent paths',
        '#128: run built-in file operations behind an OS-restricted executor while preserving approvals and Undo',
        '#97 and #87: upstream proxy and process-wrapper references were added to the existing network and MCP issues rather than duplicated',
      ],
      'Keep existing fail-closed behavior. Do not copy network throttling as a network-denial guarantee; validate every claimed boundary on real backends.',
    ],
    [
      'Add unit tests to the renderer',
      `${D.areas
        .filter((area) => area.proc === 'renderer')
        .reduce((sum, area) => sum + area.lines, 0)
        .toLocaleString()} renderer TypeScript lines have 138 unit-test lines (ratio 0.04), against 0.7 to 2.1 for the main-process areas.`,
      [
        'app.ts (826), dialogs.ts (742), panels.ts (648), transcript.ts (572) have no test file',
        'app.ts is also among the most-changed source files (29 changes in 60 days)',
        '#62 asks for e2e tests of the chat list, model picker and status-bar branch',
        '#47 (failed tool cards should say why) is a UI change that would land in this untested code',
      ],
      'Start with the pure logic in transcript and app (event handling) rather than DOM details.',
    ],
    [
      'Get release bookkeeping straight before the next tag',
      'package.json says 0.1.0 while old tags already go to v0.3.0; the CHANGELOG has only [Unreleased] with 134 bullets; Windows signing waits on a certificate.',
      [
        'release.yml checks the tag against package.json, and tag v0.1.0 already points at an old commit',
        '#26 (signing, checksums) and #28 (macOS entitlements) are sev:medium',
        '#71, #70, #119, #22 are low-severity release items',
      ],
      'Mostly a decision (what to do with the old v0.1.0 to v0.3.0 tags) plus a CHANGELOG cut.',
    ],
  ];
  return [
    h('h2', null, 'What to focus on next'),
    h(
      'p',
      { class: 'lead' },
      'A ranked shortlist drawn from the data on the other tabs: open issues and their severity, test gaps, CI state and churn. Order: security risk first, then the things that make every later change safer.',
    ),
    h(
      'div',
      { class: 'focus' },
      items.map(([t, what, ev, note], i) =>
        h(
          'div',
          { class: 'card fitem' },
          h('div', { class: 'rank' }, i + 1),
          h(
            'div',
            null,
            h('h3', null, t),
            h('div', { class: 'small' }, what),
            h(
              'ul',
              { class: 'small' },
              ev.map((e) => h('li', null, e)),
            ),
            h('div', { class: 'why' }, note),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'card', style: 'margin-top:14px' },
      h('h3', null, 'Also worth knowing (low effort, low risk)'),
      h(
        'ul',
        { class: 'small', style: 'margin:0;padding-left:18px' },
        h('li', null, 'McpHub still introduces itself to MCP servers as "CodeCompanion" (#72).'),
        h(
          'li',
          null,
          'main/agent and main/tools import each other: one import back from tools to agent closes the cycle.',
        ),
        h(
          'li',
          null,
          'Crash-resume checkpoints write in the background (#55), but full chat saves are still synchronous (#118).',
        ),
        h(
          'li',
          null,
          'CI is green on Windows, Linux and macOS again since #137. The crash_kill approval e2e test still stalls intermittently on Windows and macOS (#138); queued jobs sometimes time out waiting for a hosted runner and need a re-run.',
        ),
      ),
    ),
  ];
};
