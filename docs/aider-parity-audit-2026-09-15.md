# Aider parity audit — 2026-09-15

## Scope and method

This audit compares clean source trees at:

- Patch `1bf2ca6adbc3f4774612590f3f7c59c636a4a6e9`; and
- canonical aider `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`.

The external aider checkout was `../aider-upstream`; it was not copied into
Patch and Patch does not use Python at runtime. The prior 2026-09-11 and
2026-09-12 dated audits remain historical snapshots. The 2026-09-14 inventory
embedded in the live backlog audited Patch source revision `e10467b3`; Patch
source did not change between that revision and this audit boundary, but this
pass independently rechecked the behavior and corrected its documentation.

Unlike the earlier category-only inventory, this pass enumerated the pinned Git
tree independently of Patch's attribution markers. The accompanying
[source inventory](aider-source-inventory-2026-09-15.md) classifies all 80 aider
Python product modules, both model data files, and all 58 Tree-sitter queries as
implemented, partial, unported, deferred, non-goal, or excluded. It also records
the 36 upstream executable test modules and packaging/workflow boundary.

Six review streams compared coder/edit/lifecycle behavior; models, providers,
and configuration; Git, repository maps, filesystem, and processes; commands
and terminal IO; optional interfaces; and documentation/evidence. Each started
from the pinned upstream owner, traced any Patch counterpart through production
composition, and checked tests separately from runtime reachability. Focused
probes and tests were used for supported-surface defects. Existing tests prove
only the scenarios they exercise.

This was not a credentialed provider, real-device, macOS, Windows, or remote-CI
run. The default local suite used no provider credentials or external provider
requests.

## Verdict

Patch remains a substantial partial port, not a 1:1 compatible aider
replacement. Its documented core workflow is real and production-wired, but the
file-for-file inventory shows broad deliberate and unfinished differences in
provider/model controls, commands, rich terminal behavior, repository-map
languages, linting, optional interfaces, and packaging.

The audit confirms two release-blocking P0 unified-diff defects first recorded
on 2026-09-14. It also finds additional defects in supported Patch behavior:
failed provider-attempt output leaks into event consumers, three advertised
model defaults/limits disagree with the pinned source, clipboard subprocesses
are unbounded, two Windows command tokenizers discard path separators, media
and watch reads do not retain containment across an ancestor swap, and the
optional ffmpeg adapter misses pre-aborted signals. These are implementation
tasks, not reasons to weaken Patch's authorization, ambiguity rejection,
network isolation, literal Git path, or owned-undo hardening.

Documentation previously confined the 2026-09-14 defects to the backlog while
README, phase exits, and subsystem docs continued to present the superseded
claims. This audit makes those limits visible at each affected claim and changes
Phase 7 from met to blocked until both P0 items are fixed through the executable
path.

## Confirmed release blockers

### P0 — Added Markdown fences terminate unified-diff parsing

Patch `src/edits/unified-diff.ts:386` uses a non-line-anchored closing-fence
expression. A valid added or context line containing triple backticks, such as
an added TypeScript fence, terminates the match and silently drops the rest of
the hunk. Pinned `aider/coders/udiff_coder.py:312-343` closes only when the
physical diff line itself starts with the fence, so diff-prefixed Markdown
fences remain data.

The fix needs parser and installed-application cases that add, remove, and retain
Markdown fences. Until then, `udiff` must not be described as safe for arbitrary
Markdown edits.

### P0 — Empty-preimage unified-diff hunks move insertions to EOF

Patch discards every `@@` range at `src/edits/unified-diff.ts:443-445`; the
application path then appends an empty-search replacement at EOF in
`src/edits/unified-diff.ts:345-352`. A beginning- or middle-of-file insertion can
therefore be applied at the wrong location without an error. Pinned
`aider/coders/udiff_coder.py:261-279` refuses an empty preimage rather than
silently retargeting it.

Patch must preserve enough validated location information to apply uniquely or
fail closed, while retaining intentional new-file creation. Beginning, middle,
end, ambiguous, and existing-empty-file cases are required through parser and
installed application paths.

## Additional supported-surface defects

### P1 — Retried provider attempts leave stale streamed events

`src/core/coder-session.ts:861-891` forwards and stores each event immediately.
On a retry, `src/core/coder-session.ts:964-979` resets only internal partial
response/token state; neither `result.events` nor `onEvent` consumers receive a
reset. `src/core/concrete-application-service.ts:937-943` forwards those events
to production interfaces. A first attempt that emits `old`, then a retryable
error, followed by a successful `new` attempt returns/history-stores `new` but
terminal and HTTP/SSE consumers observe `oldnew` plus the stale error/reasoning
events.

Pinned aider has a related display weakness: retries surround `send()` at
`aider/coders/base_coder.py:1457-1488`, internal response state resets at
`1783-1791`, and already printed/yielded text at `1954-1972` cannot be retracted.
Patch should not preserve that accident in its structured event contract.
Buffer attempt events until success or define a reset event implemented by every
consumer; add text and reasoning retry regressions.

### P1 — Advertised model profiles disagree with pinned settings

- Patch gives `gpt-4o-mini` `diff` plus a repository map in
  `src/resources/model-settings.yml:17-25`. Pinned
  `aider/resources/model-settings.yml:85-88` leaves inherited `whole` format and
  no map.
- Pinned DeepSeek Reasoner routes both weak and editor work to
  `deepseek/deepseek-chat` at `aider/resources/model-settings.yml:582-592`.
  Patch's entry at `src/resources/model-settings.yml:68-80` omits both role
  names, so `src/models/selection.ts:26-57` reuses the reasoner itself.

Both profiles reach startup/session construction through the packaged catalog.
Tests check inventory and selected capabilities, not these exact defaults. Add
exact resource/profile tests and decide whether any difference is intentional;
if it is, document the cost/context tradeoff instead of attributing parity.

### P1 — Advertised DeepSeek limits disagree with pinned metadata

Pinned `aider/resources/model-metadata.json:2-32` specifies 128,000 input tokens,
64,000 reasoner output tokens, and 8,192 chat output tokens. Patch uses 131,072
input tokens and 65,536 reasoner output tokens at
`src/resources/model-metadata.json5:61-87`. These values are load-bearing:
`src/models/catalog.ts:125-151,219-228` merges them into prompt refusal, map
budgeting, and provider output limits.

`docs/model-catalog.md` incorrectly says the DeepSeek data comes from LiteLLM
because aider's own resource misses it. Restore the pinned values or explicitly
classify the newer/vendor values as an intentional divergence with independent
source and contract tests.

### P1 — Two Windows tokenizers discard path separators

`src/commands/parse.ts:76-115` treats every backslash as a generic escape, so
`/add C:\repo\file.ts` becomes `C:repofile.ts`; the same parser feeds `/attach`,
`/drop`, and `/read-only`. Independently, `src/io/editor.ts:24-49` applies the
same rule to `--editor`, `VISUAL`, and `EDITOR`, so a quoted Windows executable
such as `C:\Program Files\Editor\editor.exe` cannot be spawned. Pinned aider
preserves command paths through `aider/commands.py:1328-1345` and delegates its
editor command to the platform shell at `aider/editor.py:89-134`.

Fix both parsers with drive, UNC, relative, spaces, quoting, and literal-
backslash cases without regressing POSIX escaping. Until then, docs must warn
that these path forms are unsupported.

### P1 — Clipboard subprocesses are unbounded and uncancellable

`src/io/integrations.ts:63-83` spawns optional clipboard utilities with no
timeout or abort signal and buffers all stdout. `/paste` awaits this while its
session queue is serialized. A hung or hostile `xclip`, `wl-paste`, PowerShell,
or platform replacement can block the session indefinitely or exhaust memory;
`/copy` can also hang.

Pinned aider's `pyperclip.paste()` at `aider/commands.py:1316-1322` is likewise
unbounded. Patch should apply its process-hardening policy rather than copy that
weakness: bound time and bytes, forward cancellation, terminate/drain the child,
and test executable failure/cleanup paths.

### P1 — Media and watch reads do not retain ancestor containment

`src/core/media-context.ts:82-106` resolves a canonical path and later opens that
pathname. `O_NOFOLLOW` protects only the final component; swapping an ancestor
between resolution and open can redirect the read outside the selected root.
Likewise `src/interfaces/watch-mode.ts:223-244` resolves, stats, and reads by
pathname in separate operations, allowing an ancestor swap to inject external
AI comments into provider context. Current tests cover static escaping symlinks,
not swaps after resolution.

Pinned aider is not stronger (`aider/coders/base_coder.py:817-857` and
`aider/watch.py:90-118`). These are Patch containment defects, not strict parity
gaps. Reuse an identity/ancestor-pinning policy appropriate for read-only files,
or explicitly narrow the local-adversary threat model if Node cannot close the
window portably.

### P1 — Documentation implied a nonexistent `/diff`

`docs/terminal.md` previously called Git-backed `/diff` a separate operation,
but `src/commands/parse.ts:20-41` has no such command. Pinned aider implements it
at `aider/commands.py:657-689`. The wording is corrected to “unimplemented” in
this audit; adding a bounded, sanitized `/diff` remains backlog work.

## Partial and deferred parity corrections

### P2 — Variable Markdown fences lose syntax language

`src/io/render.ts:121-130` recognizes a four-backtick opening fence by matching
only its first three backticks, so the captured language is empty. Pinned aider
delegates variable fence lengths to Rich Markdown in
`aider/mdstream.py:81-139`. Add opening/closing, split-chunk, and language cases.

### P2 — Close-only reasoning cleanup cannot retract display

Patch correctly removes a closing-tag-without-opening-prefix from final history
and edit parsing, but `src/core/coder-session.ts:953-961` explicitly notes that
the earlier content has already streamed to the screen. The prior backlog claim
that reasoning content never reaches display was too broad. Complete open/close
tags are split as they arrive; close-only cleanup is final-response-only.

### P2 — Aider command aliases and bare `/read-only` are unported

Pinned aider treats `!command` as `/run` at `aider/commands.py:255-256,312-315`.
Patch treats it as an ordinary model message because only `/` enters command
parsing at `src/commands/parse.ts:117-123`. Pinned aider also converts all
editable chat files to read-only when `/read-only` has no argument at
`aider/commands.py:1328-1337`; Patch requires a path at
`src/commands/parse.ts:131-135`. Classify both explicitly before deciding whether
to port them. Any `!` alias must preserve Patch's preview/approval policy.

### P2 — The exported ffmpeg adapter misses pre-aborted signals

`FfmpegVoiceRecorder.record()` spawns before registering its listener and does
not check `signal.aborted` at `src/interfaces/voice.ts:178-208`. Direct callers
can therefore start a recording after cancellation and miss the abort entirely.
`VoiceInput.capture()` checks before invoking a recorder, but the adapter is an
exported package contract and current tests use fakes only. Add direct adapter
tests and check before spawning; CLI/device voice UX remains deferred.

### P2 — OpenRouter metadata/cache behavior needed an explicit disposition

Pinned `aider/openrouter.py:29-128` fetches model metadata and maintains a
24-hour home-directory cache. Patch has no OpenRouter route. Provider support is
unported; implicit startup network fetches and persistent metadata caches are an
intentional privacy non-goal unless explicit OpenRouter support is designed.

## Confirmed intentional differences

The review found no reason to weaken these Patch policies:

- unique-match and bounded edit recovery instead of first-match ambiguity;
- explicit approval for model-suggested commands and new/out-of-chat writes;
- literal Git pathspecs, composed ignore policy, session-owned undo, and
  fail-closed publication checks;
- atomic replacements with documented metadata portability limits;
- explicit model selection and allowlisted credential environment variables;
- verified TLS and secret-safe diagnostics;
- explicit, DNS-pinned, bounded URL fetching with no implicit URLs or
  production subresource/browser loading;
- opt-in history persistence, no analytics/onboarding/update networking, and no
  Python runtime; and
- authenticated loopback API policy rather than public/multi-tenant hosting.

## Documentation reconciliation

This audit updates the live backlog, README, porting plan, edit, command,
terminal, model, filesystem, watch, voice, and attribution documentation.
Historical dated reports retain their original revision claims.

In particular:

- Phase 7 is blocked by the two P0 unified-diff defects even though its scoped
  recovery algorithms remain implemented.
- “all commands dispatch” means the 20 named Patch commands, not aider aliases,
  argument semantics, or prose-only `/diff`.
- “contained media/watch reads” is static containment, not protection from an
  attacker swapping an ancestor after resolution.
- reasoning-tag display exclusion applies to a complete tagged stream; final
  close-only cleanup protects history/parser but cannot retract output.
- the attribution ledger has 63 identified direct adaptations and is not an
  independent upstream-source completeness check; the new source inventory is.

## Local validation

On Linux in the audit orb with Node.js `v26.5.1`, `npm run check` passed:
format, ESLint, TypeScript, the 63-entry direct-derivation check, 685 tests with
eight gated/platform skips, a clean build, packed installation, installed commit
policy, and installed lifecycle smoke. All 79 executed Vitest files passed; two
files were skipped. A separate `npm start -- --help` and `git diff --check` also
passed.

A Git-tree completeness check found all 80 Python product modules, both model
data files, and all 58 query files in the source inventory with no omissions.
This validation is evidence for the documentation reconciliation and unchanged
default suite, not for fixing any defect reported above. It does not replace
Node 22 CI, credentialed live-provider, provisioned PTY, current-revision
macOS/Windows, or real-device evidence.
