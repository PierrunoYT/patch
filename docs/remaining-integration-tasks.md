# Remaining integration tasks

This checklist is reconciled with Patch
`58597efc390e8e138b29024871a25d192fb27462` and remains an ordered
implementation backlog. It distinguishes tested components from features that
work through the installed `patch` executable. Completing an
isolated adapter or parser is not enough to check a task or phase exit in
`PORTING_PLAN.md`.

## Completion rules

Apply these rules to every section below:

- [ ] Preserve the pinned Aider baseline and document intentional differences.
- [ ] Add failure, cancellation, malformed-input, and path-containment tests at
  every boundary that accepts untrusted input.
- [ ] Use temporary real Git repositories for repository behavior and
  deterministic providers for ordinary session tests.
- [ ] Keep live credentials out of the default test suite and diagnostics.
- [ ] Run the narrowest relevant test while developing, then run all verification
  commands listed at the end before completing a milestone.
- [ ] Update `README.md`, `CHANGELOG.md`, affected feature documentation, and
  `PORTING_PLAN.md` in the same change as completed behavior.
- [ ] Mark a `PORTING_PLAN.md` checkbox complete only when its documented user
  path works. Uncheck or qualify every checkbox and exit claim currently
  supported only by an isolated module, mock, or schema entry.

## Required implementation order

```text
R0 native footprint
  └─▶ R1 application composition root
        ├─▶ R2 end-to-end turn lifecycle
        │     └─▶ R3 slash-command dispatch
        ├─▶ R4 live provider contracts
        ├─▶ R5 cross-platform CI
        ├─▶ R6 advanced modes
        ├─▶ R7 rich terminal integration
        └─▶ R8 optional interface exposure
                └─▶ R9 documentation truth pass
```

R9 should also be applied incrementally after each milestone; its final pass
depends on all earlier scope decisions being settled.

## Pinned Aider parity re-audit — 2026-09-10

Nine read-only subsystem audits compared the production path and exported
helpers with Aider
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`. The audit inspected both source
trees; it did not run Patch tests, live providers, native tools, or CI. Existing
tests are evidence only for the cases they exercise.

| Area | Current classification | Strongest evidence boundary |
| --- | --- | --- |
| Core lifecycle | partial | Ordinary initial turns are composed; switching, failed-mutation history, continuation, and multi-session ownership are incomplete. |
| Editing | partial | Whole-file and basic SEARCH/REPLACE are strongest; Patch and unified-diff have unsafe multi-action/multi-file cases. |
| Models/providers | partial | OpenAI and Anthropic basic streaming routes exist; DeepSeek normalization, usage delivery, metadata, and retry behavior are incomplete. |
| Git/filesystem | partial with intentional hardening | Literal pathspecs, ignored-context filtering, static containment, staging, and selected commits are strong; move, metadata, race, and undo guarantees are incomplete. |
| Repository maps | partial | A five-language production map exists; failure isolation, context mode, budgeting, language breadth, and fixtures are incomplete. |
| Commands/terminal | partial | Sixteen commands dispatch; switching and paste are incorrect, while rich input and PTY remain helper-only. |
| Watch/URL/web/voice/help | partial or missing | Watch and local HTTP/SSE start; URL/voice are helper surfaces, browser GUI/help are absent, and web mutation coordination is unsafe. |
| Configuration/package/provenance | partial | The supported bootstrap subset is staged; non-repository startup, inert flags, automatic packing, installed docs, and provenance checks remain. |

### Immediate P0 blockers

- [x] Make every Git path argument literal so pathspec magic cannot stage,
  commit, diff, or undo unrelated files.
- [x] Filter tracked `.aiderignore` paths before snapshots, mention matching,
  repository maps, or provider requests.
- [ ] Preserve move sources until destinations are durably created; current
  delete-then-create ordering can lose data.
- [ ] Reject or correctly implement named Patch `@@` scopes, repeated actions,
  and conflicting actions for one path.
- [ ] Parse every unified-diff file-header transition or reject multi-file
  fences; later hunks can currently target the preceding file.
- [ ] Bind undo to a commit owned by the current session and recheck HEAD
  atomically before reset.
- [ ] Serialize repository mutations across application sessions, especially
  local HTTP/SSE sessions sharing one worktree.
- [ ] Apply one stateful sanitizer to all untrusted terminal output, not only
  PTY child output.
- [ ] Define and enforce hardlink, metadata, and check-to-use race policy for
  replacement and deletion.

### Next P1 correctness work

- [ ] Atomically switch the active model and complete strategy definition;
  rebuild prompts, shell policy, fence, map policy, and compatible history.
- [ ] Submit text returned by `/paste` as a user turn instead of displaying and
  recording it as assistant output.
- [ ] Normalize DeepSeek endpoint model/output parameters and prefill requests;
  retain final usage events through `CoderSession`.
- [ ] Make default non-repository startup and a sole directory target explicit
  supported or clearly rejected workflows.
- [ ] Add a clean `prepack` build/resource step before any publication claim.
- [ ] Reconcile history and structured partial results whenever files or commits
  survive a later failure or cancellation.
- [ ] Isolate missing/unreadable tracked files during map construction and emit
  the canonical no-editable-files prompt pair.
- [ ] Surface watch submission/native watcher failures and refresh all selected
  AI comments for a triggered turn.

### P2 parity and evidence work

- [ ] Add automatic long-history summarization and model-configured reasoning-tag
  normalization before display, history, or edit parsing.
- [ ] Merge executable metadata limits/prices/capabilities, add temperature
  policy, broaden transient error classification, and render usage/cost.
- [ ] Add important-root-file priority, per-file lexical reference fallback,
  model-aware map sizing, live inventory refresh, extractor-versioned caches,
  and broader language/query fixtures.
- [ ] Connect completion, opted-in history navigation, Emacs/Vi bindings,
  external editor, true multi-turn multiline input, and explicit PTY dispatch.
- [ ] Add contained path/directory/glob selection semantics and complete visible
  subprocess output/status without weakening Patch's authorization bounds.
- [ ] Define URL ingestion and HTML-to-readable-text behavior; keep the strict
  SSRF/no-subresource policy as an intentional security difference.
- [ ] Decide explicit dispositions for Aider help, report, settings, browser GUI,
  voice UX, analytics, onboarding/OAuth, and update/release-note families.
- [ ] Establish dirty-upstream/blob-hash fixture checks, broader production
  goldens, packed TSX extraction, installed documentation, and exact CI evidence.

The R0–R9 sections below retain dependency context. Where a checked component
conflicts with this re-audit, the unchecked blocker above controls release
status.

## R0 — Restore a portable default installation

**Status:** Complete. `node-pty` is absent from the default dependency graph and
is loaded only when explicitly provisioned for PTY execution. Package smoke
coverage verifies that normal installs do not include optional native, browser,
or audio dependencies.

- [x] Remove `node-pty` from the package's default dependency graph and update
  `package-lock.json`.
- [x] Keep `runPtyCommand` behind dynamic loading with a focused unavailable
  error. If discoverability requires metadata, use an optional peer dependency
  only after a clean-install test proves npm does not fetch or build it;
  otherwise document a separately installed external package.
- [x] Ensure importing the package root, invoking `patch --help`, and using
  non-PTY commands never resolve or probe `node-pty`.
- [x] Add package-smoke assertions that a plain clean install contains no
  `node-pty`, Playwright, bundled browser, ffmpeg, or native audio package.
- [x] Add a separately gated PTY job that explicitly installs `node-pty` and
  runs PTY contract tests on supported platforms.
- [x] Enforce LF line endings at checkout so the formatting gate remains
  deterministic on Windows hosts configured with `core.autocrlf=true`.

**Acceptance:** a plain `npm install` of the packed tarball performs no native
build and contains none of the optional native/browser dependencies, while an
explicitly provisioned PTY test still passes. The Phase 0 validation commands
must also pass from a Windows checkout with automatic line-ending conversion
enabled; the formatting gate is verified under that configuration.

## R1 — Build the real ApplicationService and composition root

**Status:** Partial. `ConcreteApplicationService` is the production composition
root used by the CLI, but it does not compose every model role, option,
strategy prompt, provider lifetime, or interface policy listed below.

### Construction and startup

- [x] Implement a concrete `ApplicationService` and `ApplicationSession` as the
  sole owners of session construction and mutable application state.
- [x] Add one composition root that runs `bootstrapConfiguration`, loads the
  `ModelCatalog`, resolves the main model, constructs its provider and strategy,
  and opens filesystem/Git adapters.
- [ ] Route every intended config-aware option through staged bootstrap. Model,
  file, Git, edit, and check controls are staged; histories, multiline,
  notifications, watch, and web remain Commander-only.
- [x] Remove `unavailableProvider` from the production path; fail before input
  starts with a secret-safe, actionable configuration diagnostic.
- [x] Add supported watcher and web startup around the concrete service.
  `--watch-files` starts Node watch around the terminal session with Git ignore
  handling; `--web --web-token-file` starts a separate authenticated loopback
  HTTP/SSE mode with the concrete service. CLI startup flags are opt-in, need
  no optional dependencies, and close resources on exit or startup failure.
  Evidence: `tests/interface-startup.test.ts` and packed concrete CLI-program
  startup in `scripts/package-smoke.mjs`. Full web operational policy remains R8.
- [ ] Define complete cleanup for provider streams, watchers, subprocesses,
  histories, and web sessions. Providers created after `/model` are not tracked.

### Context and strategies

- [x] Resolve all selected paths through `SafePathResolver`; reject mixed
  repositories and conflicting editable/read-only selections.
- [x] Build immutable per-turn snapshots and editable/read-only prompt chunks
  from current disk state.
- [x] Generate and inject repository maps when enabled, including current-turn
  filename and identifier hints.
- [x] Add a strategy registry for genuinely implemented modes and reject
  schema-only modes before a provider call.
- [ ] Give each constructed strategy its canonical system prompt, examples,
  reminders, shell policy, and per-attempt fence. Current production prompts
  are abridged and the selected fence is not used consistently.

**Acceptance:** the installed application service can start from supported
configuration, select a main provider/model/strategy, compose repository
context, and complete injected fake-provider turns. Actual-bin provider turns,
secondary roles, and the remaining items above are not established.

**Startup evidence:** `tests/application-service.test.ts`,
`tests/interface-startup.test.ts`, and `scripts/package-smoke.mjs` cover
application composition, watch/web startup and shutdown, installed fake-provider
startup, the default optional-dependency boundary, and executable help.
`tests/unified-diff.test.ts` retains the unique-hunk regression coverage. CI on
the pushed revision, rather than a frozen local test count, is the authoritative
verification result.

## R2 — Implement the correct end-to-end turn lifecycle

**Status (2026-09-10):** the concrete application now supplies per-attempt
resolution/application to `CoderSession`'s bounded loop. Installed-service
acceptance demonstrates normal ordering and exact Git state. The complete
guarantees below remain unchecked where recovery or interactive policy is not
implemented. See [turn lifecycle](turn-lifecycle.md) for pinned sources and
intentional differences.

- [ ] Refactor orchestration so every editing attempt executes in this order:
  1. compose current context and stream the provider response;
  2. parse and dry-run resolve the full edit batch;
  3. reflect on parse or application diagnostics within the configured bound;
  4. stage, preview, and authorize new/out-of-chat paths;
  5. checkpoint dirty selected files;
  6. apply the staged transaction;
  7. auto-commit changed files when enabled;
  8. lint changed files and optionally reflect, committing linter changes;
  9. preview and approve each model-suggested shell command;
  10. run configured tests and optionally reflect; and
  11. finalize history, usage, changed paths, and commit state.
- [x] Ensure lint and test commands observe the edited working tree, not an
  unapplied candidate.
- [x] Decide and document rollback behavior for a filesystem failure between
  multi-file writes; either implement checkpoint-backed restoration or correct
  the plan's unsupported atomic-rollback claim.
- [ ] Preserve unrelated staged/unstaged changes through checkpoint, commit,
  failed check, cancellation, and undo paths.
- [ ] Make cancellation at every boundary leave valid files, Git state, queue
  state, and reusable session state.
- [x] Add one asymmetric end-to-end test that streams a malformed response,
  reflects, edits multiple files, commits, fails lint once, executes an approved
  command, passes tests, and undoes only the Patch commit.
- [x] Add denial, stale snapshot, partial-write failure, rejected command,
  timeout, truncation, and cancellation variants that assert exact disk and Git
  state—not merely emitted events.
- [x] Connect standalone interactive TTY authorization for new/out-of-chat
  writes and model commands without consuming queued/partial normal input.
  `tests/terminal-approval.test.ts` covers the concrete executable program path,
  strict answers, cancellation, exact file/process effects, and noninteractive
  gating. Watch/web/one-shot and other noninteractive contexts keep denial;
  native PTY approval coverage and broader approval policies remain incomplete.

**Acceptance:** installed-service scenarios prove Patch's selected lifecycle
and Git outcomes. They do not yet prove pinned Aider lifecycle equivalence.

**Delivered evidence:** `scripts/lifecycle-smoke.mjs`, run against the clean
installed tarball by `scripts/package-smoke.mjs`, additionally includes a dry-run
resolution failure and a linter-created commit. It asserts two asymmetric file
contents, checkpoint/commit ancestry, unrelated staged and unstaged diffs,
refreshed prompt content, usage/history, and index-preserving undo. Approvals and
provider are injected into the installed service, not interactive bin prompts.
`tests/application-lifecycle.test.ts` adds real-Git failure variants, successful
and exhausted test reflection, live selection changes, and reusable queue
checks. Command timeout/output limits are shortened through the adapter for
deterministic tests; actual child execution is retained.

**Precisely remaining unchecked R2 boundaries:**

- The complete orchestration item: per-failure lint/test reflection choice
  (currently automatic for explicitly configured checks), reconciliation of
  interrupted history with already-applied edits, and complete standalone-bin
  approval-driven acceptance. The successful installed-service path finalizes
  history, usage, changed paths, and latest commit correctly.
- Unrelated-work preservation across *all* failures: normal checkpoint,
  commit, failed checks, sampled cancellation, and undo preserve the unrelated
  index/worktree in tests. Git failures after staging, failure between undo's
  two Git commands, concurrent writers/sessions, and arbitrary side effects of
  approved/configured commands are not covered by a preservation guarantee.
- Cancellation at *every* boundary: signals are checked before mutation phases
  and between file writes; running Git/replacement operations finish. Tests
  cover stream, preview, authorization, post-checkpoint, between-write,
  pre-lint/test, and command-approval cancellation. There is no cross-file
  rollback, durable journal, per-file partial-write result, or exhaustive
  fault-injection matrix. A partial write leaves completed files changed,
  preserves the checkpoint, and releases the queue for a fresh-context retry.

## R3 — Dispatch every advertised slash command

**Status:** Partial for the advertised command set. All parsed effects reach
`ConcreteApplicationSession`, but model/mode switching, `/paste`, undo
ownership, and some command output/history semantics remain incorrect.

- [x] Add an application-owned dispatcher for `/add`, `/drop`, `/read-only`,
  `/ls`, `/clear`, `/model`, `/chat-mode`, `/run`, `/test`, `/lint`, `/commit`,
  `/undo`, `/copy`, `/paste`, and `/exit`.
- [x] Resolve and authorize command paths through the same containment boundary
  as model edits; never mutate session lists from raw parser strings.
- [ ] Rebuild provider and the complete strategy/prompt state safely for
  `/model` and `/chat-mode`, preserving or summarizing compatible history.
- [x] Add an interactive CLI approver for `/run`; `/lint` and `/test` use only
  configured process adapters at the repository root. `/run` shares the terminal
  approver used for model commands and writes; outside standalone interactive
  TTY mode it defaults to denial unless an embedding caller injects approval.
- [ ] Constrain `/undo` to the current session's owned HEAD commit, selected
  paths, and supported ancestry/publication state without disturbing unrelated
  changes.
- [ ] Make `/copy` use text-only platform utilities and make `/paste` submit
  clipboard text as a user turn rather than an assistant-labelled response.
- [x] Serialize commands and provider turns through the same session queue and
  test commands submitted while a turn is active.

**Acceptance:** every advertised command must have its documented executable
effect and application-level next-turn evidence. This exit is not met.

## R4 — Add opt-in live provider contract tests

- [x] Add separately gated OpenAI and Anthropic tests using documented
  environment variables; add DeepSeek if it remains an advertised provider.
- [ ] Exercise authentication diagnostics, a minimal streamed response, usage,
  finish reasons, timeout/cancellation, and one provider-specific capability.
- [x] Ensure missing credentials skip the live suite rather than failing normal
  CI and ensure failures never print keys, headers, or response secrets.
- [x] Run live tests on a manual or protected scheduled workflow with strict
  time and cost bounds; do not run them for untrusted pull requests.
- [x] Document API/network variability and distinguish mocked adapter tests from
  live contract evidence.
- [ ] Normalize the advertised DeepSeek catalog model and request fields through
  the same factory/session path used by the executable and live contract.
- [ ] Preserve OpenAI-compatible usage events that arrive with or after finish,
  then expose accurate usage/cost at the application boundary.
- [ ] Merge executable model metadata into settings and classify transient 5xx/
  validation failures consistently with the session retry policy.

**Acceptance:** Phase 4's exit statement is backed by executable, opt-in tests
rather than only mocked Fetch responses.

## R5 — Add cross-platform CI and package evidence

- [x] Run format/lint/typecheck/unit tests once on Linux and run platform-sensitive
  integration/package jobs on Linux, macOS, and Windows with Node.js 22.
- [x] Cover path separators, symlinks or their documented Windows substitute,
  Git worktrees, process cancellation, shell argv, history permissions,
  external editor cleanup, notifications, clipboard detection, and package bins.
- [ ] Run repository-map extraction for every shipped language from the packed
  package on all supported platforms. TSX is shipped but absent from package
  smoke coverage.
- [x] Run explicit PTY tests only in jobs that provision the optional native
  dependency; verify Ctrl-C, EOF, resize, cleanup, and hostile split control
  sequences on Linux and Windows. macOS PTY is explicitly unsupported after the
  provisioned native package failed its spawn contract.
- [x] Add deterministic timeout guards and retain useful diagnostics without
  exposing environment secrets.

**Acceptance:** platform-sensitive Phase 6 and Phase 8 exit claims have green
Linux/macOS/Windows evidence or are narrowed to the platforms actually tested.

## R6 — Wire and verify advanced strategies

- [ ] Keep user-facing mode schemas/settings aligned with the six constructed
  formats. Helper-only `help`, `udiff-simple`, `architect`, `editor-*`, and
  `context` values still exist in broader schemas or model data.
- [ ] Port distinct help/editor prompts and enforce editor-specific no-shell,
  no-repo-map, and fresh-history behavior where required by pinned Aider.
- [ ] Integrate architect acceptance, fresh editor construction, state/cost/
  commit transfer, and final architect history through `ApplicationService`.
- [ ] Integrate context convergence with forced repository-map refresh, expanded
  initial map budget, complete replacement of selected files, and relevant
  identifier hints.
- [ ] Integrate prompt-cache boundaries and keepalive scheduling using only the
  cacheable prefix; document retry/cancellation behavior.
- [ ] Integrate assistant-prefill continuation and contained, size-limited image/
  PDF loading through provider capability checks.
- [ ] Add independent pinned golden fixtures plus asymmetric property tests for
  every advertised edit format, including switching away from incompatible
  protocol history.

**Acceptance:** each Phase 7 checkbox is reachable from a constructed session,
and its exit is backed by independent golden/property and switching tests.

## R7 — Integrate Phase 8 terminal behavior

**Problem:** Phase 8 modules and unit tests exist, but most are not connected to
the interactive CLI/session workflow.

- [ ] Connect command/file/identifier completion to live selected files,
  commands, and approved source content.
- [ ] Load persistent input history for navigation and append input/chat records
  only after the correct lifecycle events; test explicit paths and disabled-by-
  default behavior.
- [ ] Apply Emacs/Vi bindings and external-editor invocation in the actual input
  loop rather than exposing declarative helpers only.
- [ ] Complete terminal output safety. Markdown and diff rendering are wired,
  but the renderer does not yet strip every claimed control-sequence family.
- [ ] Dispatch interactive commands through `runPtyCommand` only when explicitly
  requested and available; keep noninteractive process execution portable.
- [ ] Generate shell completions from the real option surface, trigger
  notifications only for provider turns, and make clipboard paste submit text
  through the normal user-turn path.
- [ ] Add terminal-level tests covering Ctrl-C recovery, EOF, resize, multiline
  submission, history navigation, editor cleanup, no-color output, hostile
  provider/child control sequences, and process cleanup.

**Acceptance:** Phase 8 behavior can be exercised through `patch`, not only by
importing helper modules, and the default installation remains native-free.

## R8 — Expose Phase 9 adapters through ApplicationService

**Problem:** Watch and local HTTP/SSE startup now construct concrete application
contracts. URL context integration and complete web operational policy remain
unfinished; the API is for trusted local clients, not public hosting.

- [ ] Feed fetched URL content through bounded application context with explicit
  user intent, source labeling, and token limits; keep Playwright separately
  installed and opt-in.
- [x] Connect `AiWatchMode` to a concrete session and Git ignore checks.
  Terminal watch shares its session queue.
- [ ] Coordinate repository mutations across independent web/application
  sessions that share one worktree.
- [x] Add supported startup/configuration for the authenticated loopback web
  server and construct it with the real `ApplicationService`. Interface choices
  are explicit CLI flags; model/file settings retain staged configuration.
- [x] Define startup-failure and service-shutdown cleanup for HTTP/SSE sessions.
- [ ] Define expiry, backpressure, bounded event buffering, quotas, and
  disconnect cancellation policy.
- [x] Expose voice transcription as explicit input to an application session
  without importing voice code from the root/CLI path or requiring ffmpeg at
  install time.
- [ ] Test principal/session isolation, simultaneous terminal/watch/web work,
  conflicting cross-session writes, disconnect cancellation, and resource
  cleanup.

**Acceptance:** Phase 9 adapters drive the same session behavior as the CLI;
they do not merely compile against an interface that has no implementation.

## R9 — Correct stale plans and product documentation

- [x] Replace the stale source-baseline statement that Patch contains no
  implementation with an accurate component-versus-integration status.
- [x] Align the target `EditStrategy`, state-machine, queue, and application
  contracts in `PORTING_PLAN.md` with the chosen implementation boundaries.
- [x] Correct the recommended first slice: mark genuinely completed library work
  accurately and remove or implement the nonexistent saved-response dry-run CLI.
- [x] Rewrite README status claims that simultaneously call implemented modules
  absent and checked phases complete.
- [ ] Re-audit every Phase 0–9 checkbox against production wiring and independent
  evidence; this source comparison found multiple checked helper-only or unsafe
  paths.
- [ ] Correct Phase 3/5 lifecycle and usable-release exits after the immediate
  Git, move, undo, switching, paste, and history blockers are fixed.
- [ ] Correct Phase 6/7 parity claims after broader independent map/edit
  fixtures and the Patch/unified-diff targeting fixes exist.
- [ ] Correct Phase 8/9 checkboxes after terminal sanitization, rich input, web
  coordination, and interface policy are complete.
- [ ] Reconcile `CHANGELOG.md` wording with what users can invoke, reserving
  “support” and “parity” for safe behavior reachable through a documented
  interface.
- [ ] Establish a direct-derivation ledger and ensure every listed source or
  shipped resource carries the required upstream path, revision, modification,
  and Apache-2.0 provenance.

**Acceptance:** not met. The table and blockers above are the current
source-audit result; application fixes and executable evidence remain required.

## Verification commands and required evidence

Run these from a clean checkout with Node.js 22:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:package
npm start -- --help
```

Before claiming the MVP/session exits, also run targeted integration tests that
cover:

- [ ] packed CLI startup with config, dotenv, environment, and CLI precedence;
- [ ] actual-bin one-shot and multi-turn deterministic-provider sessions;
- [ ] edit preview, authorization denial/acceptance, dirty checkpoint, apply,
  commit, lint, approved shell command, test reflection, and owned undo;
- [ ] exact file and Git state after cancellation or every injected failure;
- [ ] every advertised slash command through its documented application effect;
- [ ] filtered repository-map context through the packed executable;
- [ ] live provider contracts through catalog, factory, and session boundaries;
- [ ] green Linux, macOS, and Windows package/platform jobs for this revision;
- [x] default packed installation with no native/browser/audio dependency; and
- [ ] explicitly provisioned PTY and optional-interface suites.

Record the exact test files/workflows next to each corrected phase exit. A green
unit test for an exported helper is evidence for that helper, not for an
installed-application parity claim.
