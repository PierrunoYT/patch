'use strict';
/* ---------------- 10. Focus ---------------- */
builders.focus = () => {
  const items = [
    [
      'Continue with medium sandbox hardening: #127 and #96',
      'The Oct 7 audit found that the sandbox itself holds, but trusted main-process code acts on paths and programs inside the writable workspace. The critical one, #141 (a git.exe planted in the project ran when the project opened), is fixed: bare program names no longer resolve in the project folder, covered by an end-to-end test. #142 is fixed too: MCP stdio servers start in a private folder with their command resolved to an absolute path, and see the project only through ${project}.',
      [
        '#143 is fixed: protected paths match case-insensitively, Windows short names expand before checks, and failed safety checks ask',
        '#144 is fixed: file reads, edits, patch writes/deletes and Undo use a native no-follow helper with expected bytes and retained handles; deterministic link-replacement tests protect outside and guarded in-project files',
        '#145 is fixed: native and container commands reject sensitive project roots before Git reservation or Windows grants; macOS command temp stays inside the project',
        '#146 to #148 are fixed: fetch_url and browser ask before local addresses in Auto mode, macOS blocks Unix sockets with network on, and the agent browses in its own session',
      ],
      'No high-severity findings remain in this snapshot. Next: protect agent/IDE/startup config from shell writes (#127), narrow remaining macOS reads (#96; command temp is now project-local), and bring host-filtered networking (done on Linux, #97) to macOS and Windows (#102 is closed: the approval card and settings say loopback services and abstract sockets are reachable, and a real-bubblewrap test checks it). Native-platform tests and packaged builds still need their own hosts.',
    ],
    [
      'Work through the medium findings from the Oct 7 code review',
      'A full code review found no critical bug. The high findings sat in lifecycle and state handling across modules, not in single functions, and are fixed.',
      [
        '#162 and #163 are fixed: a failed start closes the Windows helper’s input, so it no longer leaks an idle helper, and one recovery record that can’t be undone (such as for an unreadable PATH folder) is skipped and later quarantined instead of stopping every helper start',
        'No medium finding is still open: #176 is fixed (helpers wait for the Windows permission lock while its holder lives, instead of failing after 60 s during a large project’s first grant). #177 is fixed: drive letters now come from Z: down to D:, and sharing one drive per project is #228. #178 is fixed: Windows delegates accept arguments and .cmd/.bat programs. Low: #181 to #196 and improvements #197 to #206, except the fixed ones. Already fixed: #124 (atomic JSON temp names), #180 (exhausted pause_turn), #182 (mixed line endings), #184 (settings validation), #189 (fetch_url timeout and charset), #159 (non-UTF-8 file protection), #160 (same-project navigation), #161 (failed chat restoration), #162 (leaked helper after a failed start), #164 (output decoding), #166 (MCP reconnects), #167 (stale write_file), #169 (ignore rules), #170 (code index runs), #171 to #175, #179, #181, #183, #186 (the code index) and #203',
      ],
      'The recurring causes: side effects on every change event without comparing old and new state, state changed before validation, and error paths that do less cleanup than success paths.',
    ],
    [
      'Close the remaining Windows sandbox gaps: #101, #139 and #140',
      'The command sandbox is the main control against a prompt-injected model. The #95 fix gives native commands a minimal environment, with native-confirmed extra variable and PATH settings. Root .git is read-only on every backend (#98), and Program Files toolchains such as the official Node now work in the AppContainer (#106). On macOS, Seatbelt Mach, shared-memory and sysctl access is limited to named entries, confirmed by real-Seatbelt probes on CI (#99).',
      [
        'Native environment isolation (#95) has unit and real-backend regression probes; Windows passes locally, while Linux/macOS probes require their native hosts',
        '#129 and #132 are fixed: non-Git folders get a .git reservation file Git refuses, and projects inside another repository get a protected empty HEAD folder, so a planted bare repository is never used. The Git panel refuses push/commit when repository config runs a project file (#130)',
        '#100 is fixed: overlapping helpers share the original .git inheritance snapshot and only the last run (or recovery) restores it; a real-helper test keeps writing .git/hooks while another run exits or is killed',
        '#101: npm startup and private temp/cache handling are fixed. Default node --test is blocked upstream: it needs libuv 1.53 (released 2026-09-24), which Node.js has not merged yet (nodejs/node#66282). A Windows-sandbox timeout now tells the agent about the test-isolation=none workaround (passes real Windows tests) and the unsandboxed request. #108 is fixed: protected toolchains are copied once per version and reused (repeat official node --version ~0.3 s instead of ~4 s). #103 is fixed: the project write grant goes to a per-project capability, propagated once and revoked on close (100,000 files: 23.4 s → 0.25 s per command). Follow-ups: .git is still walked a few times per command (#139), and files moved into a project lack the grant until it is reopened (#140). #133 is fixed: the toolchain tests remove every subst drive they create, including ones a killed run left behind',
      ],
      'Project-drive crash recovery (#94) is complete. Re-check #101 when Node updates libuv; retain the metadata boundary while making narrower per-command path grants possible (#126). Microsoft Execution Containers and the OS process security environment could replace the ACL grants behind several of these issues (#226, #227). A test on 2026-10-09 kept the helper: git, npm and PowerShell fail in projects under the user profile until Windows ships PSEC 1.1 enumeration (docs/WINDOWS_SANDBOX_RESEARCH.md).',
    ],
    [
      'Finish the Electron and tool hardening from the Oct 5–6 reviews',
      'The Oct 5–6 audits found no critical issue. All four high-priority findings are fixed: grep/glob patterns run in a worker (#122), connection-string passwords are redacted (#123), saved MCP headers cannot silently go to a new URL (#110), and Git panel Discard no longer deletes what a link points to (#111).',
      [
        '#118 is fixed: full chat saves write the chat file in the background, like checkpoints. #112 is fixed: the .git check before sandboxed commands is asynchronous and cached, and stopping commands no longer uses spawnSync',
        '#114 is fixed: changes to protective rules or their ordered prefixes need native confirmation. #116 provider failure text kept out of local logs, #115 HTML-only Markdown and #113 MCP secret migration are also fixed',
        '#73 and #67 are fixed: web_search masks secrets in its query and the data flow is documented; browser guests always keep webSecurity on and new web contents are locked down by default',
        '#125: two transcript_view e2e tests fail intermittently in full runs',
        '#138: the crash_kill approval e2e test still stalls intermittently on Windows CI, also after the sandbox probes became asynchronous (#112); it needs timing logs',
      ],
      'The known protective-rule confirmation gap is closed (#114), including reorders that leave the protective rule at the same index. Continue with contained fixes and regression tests for the remaining findings.',
    ],
    [
      'Adopt narrower sandbox permissions and stronger file boundaries',
      'The Oct 6 comparison of Codex, Gemini CLI, Anthropic Sandbox Runtime and OpenHands found useful patterns without a reason to replace AppContainer. These are proposed enhancements, not claims of reproduced sandbox escapes.',
      [
        '#126: approve exact extra read/write paths for one command instead of dropping the sandbox',
        '#127: protect project-local agent, IDE and startup configuration from shell writes, including absent paths',
        '#128: add an OS-restricted file executor; #144 now provides native no-follow handles, but the helper still runs with the user’s permissions',
        '#97 and #87 are done on Linux: allow-list commands go through a filtering proxy from their own network namespace, and MCP stdio servers can opt in to bubblewrap; macOS and Windows remain',
      ],
      'Keep existing fail-closed behavior. Do not copy network throttling as a network-denial guarantee; validate every claimed boundary on real backends.',
    ],
    [
      'Add unit tests to the renderer',
      `${D.areas
        .filter((area) => area.proc === 'renderer')
        .reduce((sum, area) => sum + area.lines, 0)
        .toLocaleString()} renderer TypeScript lines have ${D.testsByArea.find((area) => area.a === 'renderer').tl} unit-test lines, against 0.7 to 2.1 test lines per source line for the main-process areas.`,
      [
        `${D.untested
          .filter(([, file]) => file.startsWith('renderer/'))
          .map(([lines, file]) => `${file.split('/').pop()} (${lines})`)
          .join(', ')} have no test file`,
        'app.ts is also among the most-changed source files (29 changes in 60 days)',
        '#62 is fixed: chat_controls.test.ts checks the chat list, model picker, mode switches and status-bar branch on screen',
        'transcript.ts has a first test file, for its pure helpers; its DOM rendering is still covered only end to end',
      ],
      'Start with the pure logic in transcript and app (event handling) rather than DOM details.',
    ],
    [
      'Get release bookkeeping straight before the next tag',
      'package.json says 0.1.0 while old tags already go to v0.3.0; the CHANGELOG has only [Unreleased] with 134 bullets; Windows signing waits on a certificate.',
      [
        'release.yml checks the tag against package.json, and tag v0.1.0 already points at an old commit',
        '#26 (signing, checksums) and #28 (macOS entitlements) are sev:medium',
        '#71 and #22 are low-severity release items; #70 (Actions pinned to SHAs) and #119 are fixed',
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
        h(
          'li',
          null,
          'main/agent and main/tools import each other: one import back from tools to agent closes the cycle.',
        ),
        h(
          'li',
          null,
          'Crash-resume checkpoints (#55) and full chat saves (#118) write the chat file in the background.',
        ),
        h(
          'li',
          null,
          'CI is green on Windows, Linux and macOS again since #137. The crash_kill approval e2e test still stalls intermittently on Windows (#138) and macOS e2e tests time out now and then (#218); queued jobs sometimes time out waiting for a hosted runner and need a re-run.',
        ),
      ),
    ),
  ];
};
