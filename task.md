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
  adapter tests, but do not cite them as executable-route evidence. Include the
  advertised DeepSeek full path in the successful protected run.
- [ ] **EVIDENCE-2: Obtain current-revision Node 22 package evidence on Linux,
  macOS, and Windows.** Include the packed executable and every shipped
  repository-map language; run provisioned PTY contracts on supported Linux and
  Windows jobs.
- [ ] **EVIDENCE-3: Obtain real-device or optional-interface evidence only for
  surfaces selected for release.** Do not claim microphone, ffmpeg device,
  browser GUI, or browser-rendered web behavior from fake adapters or loopback
  API tests.

## Product-scope decisions and parity work

These are not all release blockers. Decide each item before implementation,
record an explicit implemented/deferred/non-goal disposition, and preserve the
security rules above.

### Providers and models

- [ ] **MODEL-3:** Select provider breadth beyond OpenAI, Anthropic, and
  DeepSeek one provider at a time, with explicit credentials, capability
  contracts, deterministic tests, and opt-in live evidence.
- [ ] **MODEL-4:** Design safe executable model discovery and custom catalog,
  alias, settings, and metadata overlays with strict schemas and secret-safe
  precedence/diagnostics.
- [ ] **MODEL-5:** Add reasoning-effort and thinking-token controls only for
  models/providers that declare and test those capabilities.
- [ ] **MODEL-6:** Decide whether the executable should select and switch main,
  weak, and editor models independently while preserving atomic profile changes,
  cleanup, compatible history, and cost accounting.
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
- [ ] **PROMPT-1:** Reassess byte-level prompt or localization parity only after
  public modes are settled; current shorter English prompts are intentional and
  existing fixtures prove structure rather than exact prose.

### Commands and executable workflows

- [ ] **CMD-1:** Select bounded read-only inspection commands such as `/diff`,
  `/tokens`, `/map`, `/map-refresh`, and `/copy-context`. Prioritize `/diff`,
  which is implemented by aider but explicitly unimplemented by Patch. Preserve
  literal paths, sanitization, output bounds, and installed-bin evidence.
- [ ] **CMD-2:** Decide command aliases and argument semantics, including
  aider's `!command`, bare `/read-only`, `/reset`, `/ask`, `/code`, `/ok`,
  `/multiline-mode`, and `/quit`. Any shell alias remains previewed and
  approval-gated.
- [ ] **CMD-3:** Decide file/script command breadth (`/git`, `/load`, `/save`,
  `/editor`, and `/edit`) with containment, per-effect approval, output bounds,
  cancellation, and queue semantics.
- [ ] **CMD-4:** Decide offline apply and diagnostic CLI modes such as
  `--apply`, clipboard edit application, `--show-repo-map`, and
  `--show-prompts`; require bounded inputs, dry-run/authorization contracts,
  redaction, and exact exit statuses.
- [ ] **CMD-5:** Add model-search, role-model, reasoning-effort, and thinking
  aliases only after the corresponding model-control decisions above.

### Configuration, history, terminal, and clipboard

- [ ] **CONFIG-1:** Decide chat restoration, LLM-wire logging, and command-file
  load/save. Define retention, permissions, corruption recovery, size bounds,
  redaction, and approval for loaded effects.
- [ ] **CONFIG-2:** Expose preserve/LF/CRLF policy only with full configuration
  precedence and packed cross-platform tests.
- [ ] **CONFIG-3:** Add text encodings beyond UTF-8, UTF-16LE, and Latin-1 only
  with fatal decode, BOM, round-trip, newline, and platform evidence.
- [ ] **TERM-2:** Decide non-streaming and terminal presentation controls beyond
  `--no-color`.
- [ ] **TERM-3:** Schedule computed edit previews, richer Markdown rendering,
  and true Vi input only as a coherent terminal project that retains sanitizer
  and approval boundaries.
- [ ] **CLIP-1:** Decide visible, approved clipboard-image ingestion through the
  existing bounded media path.
- [ ] **SHELL-1:** Expand shell completion only for shells with maintained tests;
  decide runtime toggles for shell suggestions and line editing without
  bypassing command approval.

### Repository maps, Git, recovery, and checks

- [ ] **MAP-1:** Select repository-map languages beyond the shipped eleven. Add
  a pinned tag fixture, packaged grammar/query evidence, cache fingerprinting,
  and cross-platform extraction per language.
- [ ] **MAP-2:** Decide whether to expose map token, refresh, multiplier, and
  display controls through configuration and commands.
- [ ] **MAP-3:** Extend arbitrary-program ranking/rendering parity only with
  independent fixtures while retaining strict token ceilings and unreadable-
  file isolation.
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
- [ ] **WEB-1:** Decide browser-rendered pages and automatic URL detection only
  under a separate threat model and approval boundary. Do not weaken explicit,
  DNS-pinned, bounded, no-subresource fetching.
- [ ] **PROVENANCE-1:** Decide whether provenance verification should cover
  transitive upstream imports and resource hashes in addition to the current
  direct-derivation ledger and source inventory.

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
