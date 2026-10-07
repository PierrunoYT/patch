'use strict';
/* ---------------- 10. Focus ---------------- */
builders.focus = () => {
  const items = [
    [
      'Fix the Oct 7 audit findings that reach code outside the sandbox: #141 to #145',
      'The Oct 7 audit found that the sandbox itself holds, but trusted main-process code acts on paths and programs inside the writable workspace. #141 (a git.exe planted in the project runs when the project opens and before every Windows sandboxed command) is critical and was reproduced on Windows.',
      [
        '#141: set NoDefaultCurrentDirectoryInExePath and spawn git, PowerShell and docker by absolute path',
        '#142: MCP stdio servers start in the project folder, so npx.cmd or node_modules/.bin there replaces the configured command',
        '#143: the protected-path guard is case-sensitive and misses 8.3 names, so Auto mode writes .GIT/config without asking (reproduced)',
        '#144: file tools check a path, then write it later; a sandboxed background command can swap in a symlink (Linux, macOS)',
        '#145: opening the home folder as a project makes all of it writable to sandboxed commands',
        '#146 to #148 (medium): main-process network tools in Auto mode, macOS Unix sockets, the browser tool’s cookie session',
      ],
      'Fix #141 first: it needs no agent at all, only opening a repository on Windows. Each fix needs a regression test that plants the file or link it guards against.',
    ],
    [
      'Fix the high-severity bugs from the Oct 7 code review: #159 to #163',
      'A full code review found no critical bug. The high findings sit in lifecycle and state handling across modules, not in single functions.',
      [
        '#159: edit_file and apply_patch rewrite a non-UTF-8 file as UTF-8, replacing bytes far from the edit (confirmed)',
        '#160: opening a chat or clicking the active project tab kills the terminal shell and clears the commit message',
        '#161: a chat that cannot be restored still switches the main process to its project, so the next message runs where the UI is not',
        '#162, #163: the Windows sandbox leaks a helper process per failed start, and one unreadable PATH folder stops every later start',
        '#164 to #178 (medium) and #179 to #196 (low): output decoding, orphaned processes, MCP reconnects, stale ignore rules, the code index, settings recovery and more',
      ],
      'The recurring causes: side effects on every change event without comparing old and new state, state changed before validation, and error paths that do less cleanup than success paths.',
    ],
    [
      'Close the remaining Windows sandbox gaps: #101 and #133',
      'The command sandbox is the main control against a prompt-injected model. The #95 fix gives native commands a minimal environment, with native-confirmed extra variable and PATH settings. Root .git is read-only on every backend (#98), and Program Files toolchains such as the official Node now work in the AppContainer (#106). On macOS, Seatbelt Mach, shared-memory and sysctl access is limited to named entries, confirmed by real-Seatbelt probes on CI (#99).',
      [
        'Native environment isolation (#95) has unit and real-backend regression probes; Windows passes locally, while Linux/macOS probes require their native hosts',
        '#129 and #132 are fixed: non-Git folders get a .git reservation file Git refuses, and projects inside another repository get a protected empty HEAD folder, so a planted bare repository is never used. The Git panel refuses push/commit when repository config runs a project file (#130)',
        '#100 is fixed: overlapping helpers share the original .git inheritance snapshot and only the last run (or recovery) restores it; a real-helper test keeps writing .git/hooks while another run exits or is killed',
        '#101: npm startup and private temp/cache handling are fixed. Default node --test is blocked upstream: it needs libuv 1.53, which no Node release bundles yet. A Windows-sandbox timeout now tells the agent about the test-isolation=none workaround (passes real Windows tests) and the unsandboxed request. #108 is fixed: protected toolchains are copied once per version and reused (repeat official node --version ~0.3 s instead of ~4 s). #103 is fixed: the project write grant goes to a per-project capability, propagated once and revoked on close (100,000 files: 23.4 s → 0.25 s per command). Follow-ups: .git is still walked a few times per command (#139), and files moved into a project lack the grant until it is reopened (#140). Still open: toolchain tests leave subst drives behind (#133)',
      ],
      'Project-drive crash recovery (#94) is complete. Fix #133, and re-check #101 when Node updates libuv; retain the metadata boundary while making narrower per-command path grants possible (#126).',
    ],
    [
      'Finish the Electron and tool hardening from the Oct 5–6 reviews',
      'The Oct 5–6 audits found no critical issue. All four high-priority findings are fixed: grep/glob patterns run in a worker (#122), connection-string passwords are redacted (#123), saved MCP headers cannot silently go to a new URL (#110), and Git panel Discard no longer deletes what a link points to (#111).',
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
