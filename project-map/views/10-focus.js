'use strict';
/* ---------------- 10. Focus ---------------- */
builders.focus = () => {
  // Test lines per source line in the main-process areas.
  const mainRatios = D.testsByArea.filter((area) => area.a.startsWith('main/')).map((area) => area.tl / area.src);
  const items = [
    [
      'Fix the Oct 13 Electron + Rust audit findings (#299–#305)',
      'An Electron, IPC and native-helper audit found strong process isolation, typed IPC schemas and handle-confined file operations, plus 10 issues across the Rust sidecar helpers, main-thread directory walks and browser DNS caching. The high one, #296 (sandbox-helper --stdio closed its own standard handles), is fixed, and so is #298: net-bridge is pinned by digest like the other helpers, and its Windows copy is read-only to the command. #297 is fixed too: the native helpers refuse files over 16 MB and cap their input.',
      [
        '#300, #302 and #305 (low): isAppPageUrl checks devRendererUrl with startsWith; openInEditor passes unscrubbed env and allows %VAR% in file paths on Windows; runtime renderer packages sit in devDependencies',
      ],
      '#301 is fixed: a public page in the agent browser goes through a proxy that pins each connection to the address it checked, #304: the network relay and net-bridge serve at most 64 connections at once, #303: folder sizes for Windows grants are measured off the main thread, and #299: the Windows sandbox helper keeps Arc<Handle> in Jobs, frees its attribute list on early returns and recovers poisoned mutexes. The remaining low-severity items are next.',
    ],
    [
      'Fix the Oct 11 audit findings: the low ones next',
      'A full audit with a second pass found the renderer, IPC, workspace confinement and approval logic sound, but a few places where untrusted content can still run code outside the sandbox, plus some data-loss and provider bugs. Each finding has an issue with its location, reproduction and fix. Both high findings are fixed.',
      [
        '#273 and #274 are fixed: the Git panel no longer looks inside submodules, whose own config could name filters, and also neutralizes filters from .git/config.worktree; host Git in a terminal still recurses into a submodule whose .git a sandboxed command replaced (#294)',
        '#275 is fixed: rg --pre, tar --to-command, fd -x, abbreviated options such as sort --outp, and sed, awk and perl with other arguments ask even when allowed',
        '#276 is fixed: the protected-config guard moves a new entry aside instead of deleting it, and leaves one the edit tools wrote to',
        '#277 is fixed: a failed or cut-off Responses stream fails the turn and is retried instead of becoming an empty answer',
        '#278 is fixed: compacting a Responses chat on a custom base URL goes to that URL, not to api.openai.com',
        '#279 is fixed: no permission rule skips the plan or remember card',
        "#280 is fixed: the app page's CSP allows no requests, so an injected script cannot fetch local files over file://",
        "#281 is fixed: a file:// page in the user's Browser session loads only files in its own folder and gets no network",
        '#282 is fixed: project:open opens a folder that is not in the project list only after a native confirmation',
        '#286 is fixed: search_code masks secrets in the query before sending it for embedding and reranking',
      ],
      'Order: the remaining low findings (#283 to #293), then #294.',
    ],
    [
      'The Oct 10 audit is fixed: approval bypasses and untrusted Claude Code settings',
      'The audit found that the text checks deciding which commands skip the approval card could be bypassed, because bash and PowerShell read a command differently from the checks, and that Claude Code chats applied a cloned repository’s own Claude Code settings. Each finding was reproduced first (unit tests, PowerShell, and for #270 an end-to-end test with the installed Claude Code) and is fixed with a regression test.',
      [
        '#264 is fixed: an allow rule such as "npm test*" no longer covers what is chained after the command; a chained command needs every part allowed, and substitutions or redirections are never allowed by a rule',
        '#265 is fixed: allowed commands are checked as the shell passes their arguments on (typographic quotes, backslashes, long dashes), and -o/-O in a group of short flags asks',
        '#266 is fixed: reject and ask rules also see commands inside $(…), backticks, (…) and {…}',
        '#267 is fixed: apply_patch refuses to run when a file changed after its diff was shown, like edit_file (#255)',
        '#268 is fixed: a browser screenshot of a project file asks, since images are not redacted',
        '#269 is fixed: live command output is redacted a line at a time, so a secret split between chunks is hidden',
        '#270 is fixed: a repository’s .claude/settings.json hooks ran commands on the first Claude Code message and its allow rules skipped the approval card; Claude Code chats now load only the user’s settings and get the project’s AGENTS.md and CLAUDE.md as instructions',
      ],
      'Command-text checks remain best effort: a delegate permission program or the sandbox is the boundary for commands that must be understood.',
    ],
    [
      'Finish the Oct 9 audit: the macOS items',
      'A full audit with a second pass found no Windows sandbox escape on its own; the worst issues were chains past the approval card. Most of its findings are fixed: the agent browser goes offline for project files and keeps public pages off local addresses (#229, #235), MCP cards show arguments (#230), Initialize stops sandboxed processes first (#231), the proxy checks TLS server names (#239), plan mode and permission rules are enforced as documented (#237, #238), and secrets stay out of embeddings and truncated output (#234, #253). A public page cannot reach local services by a name that resolves to one (#260), a failed patch is undone in the native helper (#242), and only the Patch sandbox can read the Windows toolchain cache (#151).',
      [
        '#240 is fixed: a message the API refuses with 400 or 413 is taken back, user images are checked by their bytes and size, and tool-result images become text for a model that takes none',
        '#232 is fixed: Seatbelt denies /dev/ptmx and every /dev/ttys*, so a command cannot read or print into another terminal; programs that open their own pty need an unsandboxed run',
        '#257 (macOS, unverified): hard links into the project may get past the hidden home folder and read-only .git',
        '#259 is fixed: the native file helper replaces a file through a flushed temporary file and a rename, so a crash leaves the old or the new file, never a short one',
      ],
      '#257 needs a Mac to verify; the #232 regression test runs on the macOS CI job.',
    ],
    [
      'Continue with medium sandbox hardening: #96 and #271',
      'The Oct 7 audit found that the sandbox itself holds, but trusted main-process code acts on paths and programs inside the writable workspace. The critical one, #141 (a git.exe planted in the project ran when the project opened), is fixed: bare program names no longer resolve in the project folder, covered by an end-to-end test. #142 is fixed too: MCP stdio servers start in a private folder with their command resolved to an absolute path, and see the project only through ${project}.',
      [
        '#143 is fixed: protected paths match case-insensitively, Windows short names expand before checks, and failed safety checks ask',
        '#144 is fixed: file reads, edits, patch writes/deletes and Undo use a native no-follow helper with expected bytes and retained handles; deterministic link-replacement tests protect outside and guarded in-project files',
        '#145 is fixed: native and container commands reject sensitive project roots before Git reservation or Windows grants; macOS command temp stays inside the project',
        '#146 to #148 are fixed: fetch_url and browser ask before local addresses in Auto mode, macOS blocks Unix sockets with network on, and the agent browses in its own session',
        '#127 is fixed: the project’s existing top-level editor, agent and CI configuration (.vscode, .claude, .agents, .patch, .github, .mcp.json, AGENTS.md and others) is read-only in every sandbox backend, like .git',
      ],
      'Next: protect symlinked configuration names and nested copies (#271; #262 now moves protected entries a command created aside), narrow remaining macOS reads (#96; command temp is now project-local), and bring host-filtered networking (done on Linux and Windows, #97) to macOS and containers (#102 is closed: the approval card and settings say loopback services and abstract sockets are reachable, and a real-bubblewrap test checks it). Native-platform tests and packaged builds still need their own hosts.',
    ],
    [
      'Work through the medium findings from the Oct 7 code review',
      'A full code review found no critical bug. The high findings sat in lifecycle and state handling across modules, not in single functions, and are fixed.',
      [
        '#162 and #163 are fixed: a failed start closes the Windows helper’s input, so it no longer leaks an idle helper, and one recovery record that can’t be undone (such as for an unreadable PATH folder) is skipped and later quarantined instead of stopping every helper start',
        'No medium finding is still open: #176 is fixed (helpers wait for the Windows permission lock while its holder lives, instead of failing after 60 s during a large project’s first grant). #177 is fixed: drive letters now come from Z: down to D:, and #228 is fixed: runs share one drive per project, one for temporary folders and one for the toolchain cache. #178 is fixed: Windows delegates accept arguments and .cmd/.bat programs. Low: #181 to #196 and improvements #197 to #206, except the fixed ones. Already fixed: #124 (atomic JSON temp names), #180 (exhausted pause_turn), #182 (mixed line endings), #184 (settings validation), #189 (fetch_url timeout and charset), #159 (non-UTF-8 file protection), #160 (same-project navigation), #161 (failed chat restoration), #162 (leaked helper after a failed start), #164 (output decoding), #166 (MCP reconnects), #167 (stale write_file), #169 (ignore rules), #170 (code index runs), #171 to #175, #179, #181, #183, #186 (the code index) and #203',
      ],
      'The recurring causes: side effects on every change event without comparing old and new state, state changed before validation, and error paths that do less cleanup than success paths.',
    ],
    [
      'Close the remaining Windows sandbox gaps: #101 and #139',
      'The command sandbox is the main control against a prompt-injected model. The #95 fix gives native commands a minimal environment, with native-confirmed extra variable and PATH settings. Root .git is read-only on every backend (#98), and Program Files toolchains such as the official Node now work in the AppContainer (#106). On macOS, Seatbelt Mach, shared-memory and sysctl access is limited to named entries, confirmed by real-Seatbelt probes on CI (#99).',
      [
        'Native environment isolation (#95) has unit and real-backend regression probes; Windows passes locally, while Linux/macOS probes require their native hosts',
        '#129 and #132 are fixed: non-Git folders get a .git reservation file Git refuses, and projects inside another repository get a protected empty HEAD folder, so a planted bare repository is never used. The Git panel refuses push/commit when repository config runs a project file (#130)',
        '#100 is fixed: overlapping helpers share the original .git inheritance snapshot and only the last run (or recovery) restores it; a real-helper test keeps writing .git/hooks while another run exits or is killed',
        '#101: npm startup and private temp/cache handling are fixed. Default node --test is blocked upstream: it needs libuv 1.53 (released 2026-09-24), which Node.js has not merged yet (nodejs/node#66282). A Windows-sandbox timeout now tells the agent about the test-isolation=none workaround (passes real Windows tests) and the unsandboxed request. #108 is fixed: protected toolchains are copied once per version and reused (repeat official node --version ~0.3 s instead of ~4 s). #103 is fixed: the project write grant goes to a per-project capability, propagated once and revoked on close (100,000 files: 23.4 s → 0.25 s per command). Follow-up: .git is still walked a few times per command (#139). #140 is fixed: entries moved into a project inherit its grant again before the next command, without a walk of the project. #150 and #207 are fixed too: memory is limited for the whole job with a 90% CPU cap, and unreadable toolchains are always copied, never granted. #133 is fixed: the toolchain tests remove every subst drive they create, including ones a killed run left behind',
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
        '#138: the crash_kill approval e2e test still stalls intermittently on Windows CI, also after the sandbox probes became asynchronous (#112). The app log now records event-loop and file system stalls and slow background saves, and the test prints it on failure; the next stall should name the cause',
      ],
      'The known protective-rule confirmation gap is closed (#114), including reorders that leave the protective rule at the same index. Continue with contained fixes and regression tests for the remaining findings.',
    ],
    [
      'Adopt narrower sandbox permissions and stronger file boundaries',
      'The Oct 6 comparison of Codex, Gemini CLI, Anthropic Sandbox Runtime and OpenHands found useful patterns without a reason to replace AppContainer. These are proposed enhancements, not claims of reproduced sandbox escapes.',
      [
        '#126: approve exact extra read/write paths for one command instead of dropping the sandbox',
        '#271: protect symlinked top-level configuration names and nested editor configuration (absent entries are moved aside after a command since #262)',
        '#128: add an OS-restricted file executor; #144 now provides native no-follow handles, but the helper still runs with the user’s permissions',
        '#97 and #87 are done on Linux and Windows: allow-list commands go through a filtering proxy (own network namespace on Linux, no network capability plus a named-pipe relay on Windows), and MCP stdio servers can opt in; macOS remains',
      ],
      'Keep existing fail-closed behavior. Do not copy network throttling as a network-denial guarantee; validate every claimed boundary on real backends.',
    ],
    [
      'Add unit tests to the renderer',
      `${D.areas
        .filter((area) => area.proc === 'renderer')
        .reduce((sum, area) => sum + area.lines, 0)
        .toLocaleString()} renderer TypeScript lines have ${D.testsByArea.find((area) => area.a === 'renderer').tl} unit-test lines, against ${Math.min(...mainRatios).toFixed(1)} to ${Math.max(...mainRatios).toFixed(1)} test lines per source line for the main-process areas.`,
      [
        `${D.untested
          .filter(([, file]) => file.startsWith('renderer/'))
          .map(([lines, file]) => `${file.split('/').pop()} (${lines})`)
          .join(', ')} have no test file`,
        `app.ts is also among the most-changed source files (${D.churn.find(([file]) => file === 'src/renderer/src/app.ts')[1]} changes)`,
        '#62 is fixed: chat_controls.test.ts checks the chat list, model picker, mode switches and status-bar branch on screen',
        'transcript.ts has a first test file, for its pure helpers; its DOM rendering is still covered only end to end',
      ],
      'Start with the pure logic in transcript and app (event handling) rather than DOM details.',
    ],
    [
      'Get release bookkeeping straight before the next tag',
      `package.json says 0.1.0 while old tags already go to v0.3.0; the CHANGELOG has only [Unreleased] with ${D.changelogEntries} entries; Windows signing waits on a certificate.`,
      [
        'release.yml checks the tag against package.json, and tag v0.1.0 already points at an old commit',
        '#26 (signing, checksums) and #28 (macOS entitlements) are sev:medium',
        '#71 and #22 are low-severity release items; #70 (Actions pinned to SHAs) and #119 are fixed',
      ],
      'Mostly a decision (what to do with the old v0.1.0 to v0.3.0 tags) plus a CHANGELOG cut.',
    ],
    [
      'Claude Code integration (#261) is done: approval, stop, restart and resume are verified',
      'Chats on a claude-code model run in the installed Claude Code through the Agent SDK. The real-CLI end-to-end test checks approval, stop, restart and resume against a local mock.',
      [
        'Mock real-CLI verified; live accounts and billing were not tested',
        'Native Windows commands run unsandboxed; the command sandbox is deliberately not forced on Claude Code',
        'Keep the separation clear when tool or UI controls are added: Patch controls do not apply to externally owned tools',
      ],
      'No open follow-up is recorded for this item.',
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
