# Patch issue and task register

## Purpose

This is the consolidated, deduplicated queue for unresolved Patch work. It
combines correctness issues from the
[2026-09-15 aider parity audit](docs/aider-parity-audit-2026-09-15.md) with open
implementation, product-decision, and evidence tasks from the
[detailed integration backlog](docs/remaining-integration-tasks.md).

The audit and its
[source inventory](docs/aider-source-inventory-2026-09-15.md) are the evidence
sources. The detailed backlog preserves historical findings, completed work,
revision-specific test results, and implementation context. Update this file
when an issue changes state; update the detailed evidence and affected subsystem
documentation in the same change.

Baseline for the current findings:

- Patch source: `1bf2ca6adbc3f4774612590f3f7c59c636a4a6e9`
- aider source: `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`
- Complete upstream inventory: 80 Python product modules, two model resources,
  and 58 Tree-sitter queries

## Working rules

- P0 items are release blockers. Fix them through the installed production path
  before claiming the affected phase complete.
- Preserve Patch's ambiguity rejection, explicit path/write/command approval,
  process bounds, literal Git paths, session-owned undo, verified TLS, bounded
  explicit networking, and opt-in persistence. Upstream behavior is not a
  reason to weaken these controls.
- Treat model output, configuration, paths, subprocesses, and network responses
  as untrusted input. Test malformed input, cancellation, partial failure, and
  containment where applicable.
- Use deterministic providers and temporary real Git repositories in the
  default suite. Keep live credentials out of tests and diagnostics.
- A task is complete only when its documented executable path, focused tests,
  package/installed-path evidence where relevant, and documentation are all
  updated. Run `npm run check` before completion.
- Keep Patch's accepted non-goals: no Python/aider runtime, analytics,
  automatic onboarding/OAuth, implicit provider metadata networking, built-in
  updater, or Docker-distribution parity.

## Resolved P0 release blockers

- [x] **UDIFF-1: Preserve Markdown fence lines inside unified-diff hunks.**
  Line-anchor the response-fence terminator so added and context lines that
  contain triple backticks remain diff data. Cover added, removed, and retained
  fences in parser and installed-turn tests. Completed with physical-line fence
  scanning and packed executable coverage.
- [x] **UDIFF-2: Apply insertion-only hunks at a validated location or reject
  them.** Numeric `@@` ranges are retained for empty-preimage edits, checked
  against hunk counts and preceding validated-insertion offsets, and bounded
  against the current snapshot. Missing, inconsistent, and out-of-file
  locations fail closed.
  Beginning, middle, end, repeated text, new-file, existing-empty-file, and
  installed middle-insertion cases are covered.

## P1 — supported-surface correctness and safety

- [x] **CORE-1: Make provider retries observer-atomic.** Buffer each attempt's
  text, reasoning, and error events until it succeeds, or add a reset protocol
  implemented by every terminal and HTTP/SSE consumer. Failed-attempt output
  must not appear as accepted turn output when history and edit parsing retain
  only the successful attempt. Completed 2026-09-15: `CoderSession` now buffers
  every validated event per provider attempt and forwards it only after an
  accepted finish; focused session and concrete application tests prove stale
  text, reasoning, usage, and retry errors never reach result/interface events.
- [x] **MODEL-1: Align bundled model role defaults.** `gpt-4o-mini` now uses
  pinned aider's `whole` format without a repository map, and DeepSeek Reasoner
  routes weak/editor work to DeepSeek Chat. Exact catalog, selection, and
  production summary/editor tests cover the bundled profiles.
- [x] **MODEL-2: Reconcile bundled DeepSeek token limits.** Both DeepSeek
  profiles now use pinned aider's 128,000-token input limit; Chat retains 8,192
  output tokens and Reasoner uses 64,000. Exact catalog assertions and concrete
  provider requests cover the load-bearing values.
- [x] **WIN-1: Preserve Windows backslashes in command and editor tokenizers.**
  Fix slash-command paths and configured external-editor commands together.
  Cover drive paths, UNC paths, relative paths, spaces, quotes, and literal
  backslashes without regressing POSIX escaping. Completed 2026-09-15: both
  consumers use one quote-aware word splitter that preserves separators before
  ordinary characters and UNC prefixes while retaining POSIX whitespace, quote,
  and literal-backslash escapes; focused tests cover every listed form.
- [x] **PROC-1: Bound and cancel clipboard utility subprocesses.** Limit time
  and read/write bytes, forward cancellation, terminate and drain children, and
  prove a hung or overproducing utility cannot hold the serialized session
  queue. Completed 2026-09-15: clipboard utilities default to a 10-second and
  1-MiB boundary, reject oversized input/output, receive session cancellation,
  terminate their process tree, and settle only after the direct child's stdio
  closes. Executable and serialized-queue tests cover timeout, output overflow,
  cancellation, cleanup, and queue reuse.
- [x] **FS-1: Retain containment across media and watch reads.** Prevent an
  ancestor swap between canonical resolution and read/open from redirecting
  content outside the repository. Add deterministic race tests. Pinned aider is
  not stronger; this is intentional Patch hardening, not mimicry. Completed
  2026-09-15: both paths retain a no-follow file handle only after re-resolving
  the target and verifying its opened identity plus every in-root ancestor;
  deterministic pre-open swaps prove media fails and watch submits nothing.

## P2 — bounded correctness follow-ups

- [x] **TERM-1: Preserve language identifiers on variable-length Markdown
  fences.** The stream tracks the opening run length and language, accepts only
  an at-least-matching bare close, and handles openings/closings split across
  chunks. Focused tests cover highlighting and shorter nested runs.
- [x] **VOICE-1: Honor pre-aborted signals in `FfmpegVoiceRecorder`.** The
  exported adapter checks cancellation before spawning; a real subprocess test
  proves a pre-aborted call creates no child side effect or abort listener.
- [x] **CORE-2: Settle close-only reasoning display behavior.** Attempt
  buffering now reclassifies a prefix before publishing accepted events, so
  display, result, continuation, history, and parsing retain one normalized
  answer. Stream-contract tests cover split close tags and continued output.

## Release and compatibility evidence

- [ ] **EVIDENCE-1: Run low-cost credentialed OpenAI and Anthropic contracts
  through catalog, factory, and application-session boundaries.** Retain direct
  adapter tests, but do not cite them as executable-route evidence. All three
  advertised providers now have gated full-path turns; a successful protected
  run remains blocked on provider credentials.
- [x] **EVIDENCE-2: Obtain current-revision Node 22 package evidence on Linux,
  macOS, and Windows.** CI run
  [`34987388922`](https://github.com/PierrunoYT/patch/actions/runs/34987388922)
  passed the Node 22 suite, packed executable and all eleven map languages on
  Linux/macOS/Windows, and provisioned PTY contracts on Linux/Windows for
  implementation revision `44dbae712d96cf6abdf65055d3b83ecdb9ec55e0`.
- [x] **EVIDENCE-3: Require real-device evidence only for optional interfaces
  selected for release.** No microphone/CLI voice or browser GUI is selected;
  browser-rendered `/web` is a non-goal. Retain fake-adapter and loopback API
  evidence without relabeling it as device/browser evidence.

## Product-scope decisions and parity work

These are not all release blockers. Decide each item before implementation,
record an explicit implemented/deferred/non-goal disposition, and preserve the
security rules above.

### Providers and models

- [x] **MODEL-3:** Keep the current release provider boundary to OpenAI,
  Anthropic, and DeepSeek. Unnamed LiteLLM-compatible breadth is not a support
  claim; reopen expansion only for a selected provider with explicit
  credentials, capability contracts, deterministic tests, and opt-in live
  evidence.
- [x] **MODEL-4:** Expose safe executable model discovery and custom catalog
  overlays. Repeatable CLI files override singular environment files and YAML
  arrays by resource kind; all resolve from the invocation directory and are
  bounded and strictly validated before startup. `--list-models [query]` and
  `/models [query]` render only bounded canonical name/provider/edit-format
  summaries and make no provider or network call.
- [x] **MODEL-5:** Add capability-gated reasoning-effort and thinking-token
  controls. Startup and mutable commands use strict values, omit temperature,
  and map only declared custom OpenAI reasoning effort or Anthropic thinking
  budgets to typed adapter fields. Unsupported model/provider combinations fail
  before transport; no bundled model overclaims either mutable capability.
- [x] **MODEL-6:** Select and switch main, weak, and editor models independently.
  Startup roles use staged precedence; `/weak-model` and `/editor-model` resolve
  and validate before serialized assignment. Main profile/history/media remain
  intact, editor work stays fresh and isolated, summarization/commit generation
  use the current weak role, and secondary usage remains session-accounted.
- [x] **MODEL-7:** Expose prompt-cache markers independently from bounded
  keepalive. `--cache-prompts`/`--no-cache-prompts`, `PATCH_CACHE_PROMPTS`, and
  `cache-prompts` YAML use normal CLI-over-environment-over-file precedence.
  Markers remain enabled by default for capable models to preserve Patch's
  existing foreground behavior; disabling them also suppresses a configured
  keepalive schedule. Focused bootstrap, session, and production application
  tests cover precedence, marker removal, and the no-background-request path.

### Edit strategies and orchestration

- [ ] **EDIT-1:** Decide whether `udiff-simple` is a public Patch format. If
  selected, add an independent prompt/parser golden and production selection;
  otherwise record it as a non-goal.
- [ ] **MODE-1:** Decide whether to expose the implemented private architect and
  context workflows through the CLI. Require approval UX, editor selection,
  cancellation, recovery, and installed-bin tests before widening the schema.
- [ ] **MODE-2:** Decide whether incompatible model switches should summarize
  history instead of dropping incompatible messages. Preserve media filtering
  and atomic failure.
- [x] **PROMPT-1:** Keep byte-level prompt and automatic localization parity out
  of Patch's current product contract. Production prompts remain shorter and
  English-only; compatibility fixtures prove format-specific structure, chunk
  order, fence interpolation, and parser behavior rather than exact prose.
  Reopen localization as a separately designed feature only when public modes
  and language precedence are specified.

### Commands and executable workflows

- [ ] **CMD-1:** Select bounded read-only inspection commands such as `/diff`,
  `/tokens`, `/map`, `/map-refresh`, and `/copy-context`. `/diff` and `/tokens`
  are selected and production-wired. The token report counts the same current
  prompt chunks used by production, labels tokenizer versus conservative
  estimates, reports available limits/cost, excludes prompt content and the
  not-yet-known next user message, and has packed-bin evidence. Decide map
  controls and context copying individually.
- [ ] **CMD-2:** Decide command aliases and argument semantics, including
  aider's `!command`, bare `/read-only`, `/reset`, `/ask`, `/code`, `/ok`,
  `/multiline-mode`, and `/quit`. Any shell alias remains previewed and
  approval-gated.
- [ ] **CMD-3:** Decide file/script command breadth (`/git`, `/load`, `/save`,
  `/editor`, and `/edit`) with containment, per-effect approval, output bounds,
  cancellation, and queue semantics.
- [x] **CMD-4:** Keep offline saved-response and clipboard edit application out
  of Patch: model edits must pass through the composed snapshot, preview,
  authorization, transaction, Git, and recovery lifecycle. A startup-only
  `--exit` debug flag is redundant with Patch's one-shot modes. Read-only prompt
  and repository-map diagnostics remain tracked by `CMD-1` and `MAP-2` instead
  of duplicating those decisions here.
- [x] **CMD-5:** Do not track model commands as a separate implementation item.
  `/models` belongs to `MODEL-4`, reasoning/thinking controls to `MODEL-5`, and
  weak/editor model commands to `MODEL-6`; each command may be exposed only with
  its capability, validation, atomic switching, and provider tests. This closes
  the duplicate low-priority alias task without claiming those P2 controls.

### Configuration, history, terminal, and clipboard

- [ ] **CONFIG-1:** Decide chat restoration, LLM-wire logging, and command-file
  load/save. Define retention, permissions, corruption recovery, size bounds,
  redaction, and approval for loaded effects.
- [ ] **CONFIG-2:** Expose preserve/LF/CRLF policy only with full configuration
  precedence and packed cross-platform tests.
- [x] **CONFIG-3:** Keep the executable encoding contract to UTF-8, UTF-16LE,
  and Latin-1. These codecs have fatal decode or exact representability checks,
  round-trip writes, BOM retention where applicable, and newline tests.
  Arbitrary Python/ICU codec names are a non-goal because their availability
  and encode/decode behavior would make the npm package platform-dependent.
- [ ] **TERM-2:** Decide non-streaming and terminal presentation controls beyond
  `--no-color`.
- [ ] **TERM-3:** Schedule computed edit previews, richer Markdown rendering,
  and true Vi input only as a coherent terminal project that retains sanitizer
  and approval boundaries.
- [x] **CLIP-1:** Keep clipboard access text-only. Patch will not silently probe
  the OS clipboard for images or create out-of-repository temporary media;
  images and PDFs enter model context only through an explicit, visible
  `/attach <path...>` command using the bounded, approved, contained media path.
- [x] **SHELL-1:** Keep generated completion to Bash, Zsh, and Fish, the shells
  with deterministic maintained tests. Keep shell-suggestion policy bound to
  the selected edit strategy and interactive input on the single Node readline
  implementation; neither changes the requirement to preview and approve model
  commands. Wider shell support and alternate line editors are non-goals for the
  current terminal contract.

### Repository maps, Git, recovery, and checks

- [ ] **MAP-1:** Select repository-map languages beyond the shipped eleven. Add
  a pinned tag fixture, packaged grammar/query evidence, cache fingerprinting,
  and cross-platform extraction per language.
- [ ] **MAP-2:** Decide whether to expose map token, refresh, multiplier, and
  display controls through configuration and commands.
- [x] **MAP-3:** Treat exact arbitrary-program and every-language ranking parity
  as an unbounded non-goal. Patch's contract is evidence-scoped: each selected
  language needs pinned tags and packaged extraction, representative independent
  ranking/rendering fixtures, strict token ceilings, and unreadable-file
  isolation. Language and map-control expansion remain under `MAP-1`/`MAP-2`.
- [ ] **GIT-1:** Select broader Git controls individually without weakening
  literal paths, composed ignore policy, containment, or session-owned undo.
- [ ] **RECOVERY-1:** Define durable recovery and coordination, if required, for
  arbitrary approved child/Git side effects, interruption inside Git, and
  mutation by separate Patch processes.
- [ ] **CHECK-1:** Decide built-in and language-specific linting while retaining
  the rule that Patch does not guess package-manager commands in an arbitrary
  repository.
- [ ] **CHECK-2:** Decide noninteractive dry-run, one-shot commit, lint, and test
  workflows with no-write guarantees, exact exit statuses, and packed-bin
  tests.

### Optional interfaces and provenance

- [ ] **GUI-1:** Reopen browser GUI work only with session quotas, approval UX,
  reconnect/replay, secret handling, and shared-worktree concurrency defined.
  The authenticated HTTP/SSE server is an API, not a GUI.
- [ ] **VOICE-2:** Reopen production voice UX only with device selection,
  cancellation, transcript review, privacy disclosure, optional packaging, and
  real-device evidence.
- [x] **WEB-1:** Keep URL ingestion explicit, DNS-pinned, bounded, and
  no-subresource. Production browser rendering and automatic URL detection are
  security/privacy non-goals unless a separate threat model and approval
  boundary are designed.
- [x] **PROVENANCE-1:** Keep three explicit evidence boundaries: the
  direct-derivation ledger for attribution, the dated Git-tree inventory for
  upstream-source completeness, and direct-import hashes for fixture
  regeneration. Recursive Python import and blanket resource hashing are not
  Patch runtime or semantic-parity guarantees.

## Completion update template

When checking an item, record in the same change:

1. the behavior and intentional differences;
2. source files and production composition path;
3. focused tests, failure/cancellation/containment cases, and installed-path
   evidence where applicable;
4. `npm run check` result and any unavailable platform/live evidence;
5. updates to this register, the detailed backlog, `PORTING_PLAN.md`, affected
   feature docs, `README.md`, and `CHANGELOG.md`; and
6. the Patch and pinned aider revisions used for parity claims.
