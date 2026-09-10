# Remaining integration tasks

This checklist converts the re-audit of `origin/main` at `671171f` into an
ordered implementation backlog. It distinguishes tested components from
features that work through the installed `patch` executable. Completing an
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

## R0 — Restore a portable default installation

**Problem:** `node-pty` is listed in `optionalDependencies`. npm attempts to
install optional dependencies during a normal install, so the default package
still downloads and may try to build a native dependency. Dynamic loading alone
does not satisfy the Phase 8/9 default-footprint exits.

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

**Acceptance:** a plain `npm install` of the packed tarball performs no native
build and contains none of the optional native/browser dependencies, while an
explicitly provisioned PTY test still passes.

## R1 — Build the real ApplicationService and composition root

**Problem:** `src/core/application-service.ts` defines only interfaces. The CLI
still injects `unavailableProvider`; configuration, provider, session, edit,
repository, and check modules have no production composition path.

### Construction and startup

- [x] Implement a concrete `ApplicationService` and `ApplicationSession` as the
  sole owners of session construction and mutable application state.
- [x] Add one composition root that runs `bootstrapConfiguration`, loads the
  `ModelCatalog`, resolves main/weak/editor models, diagnoses credentials,
  constructs providers and strategies, and opens filesystem/Git adapters.
- [x] Route CLI configuration and selected editable/read-only files through the
  staged bootstrap instead of maintaining a separate Commander-only option set.
- [x] Remove `unavailableProvider` from the production path; fail before input
  starts with a secret-safe, actionable configuration diagnostic.
- [x] Add supported watcher and web startup around the concrete service.
  `--watch-files` starts Node watch around the terminal session with Git ignore
  handling; `--web --web-token-file` starts a separate authenticated loopback
  HTTP/SSE mode with the concrete service. CLI startup flags are opt-in, need
  no optional dependencies, and close resources on exit or startup failure.
  Evidence: `tests/interface-startup.test.ts` and packed concrete CLI-program
  startup in `scripts/package-smoke.mjs`. Full web operational policy remains R8.
- [x] Define explicit cleanup for provider streams, watchers, subprocesses,
  histories, and web sessions.

### Context and strategies

- [x] Resolve all selected paths through `SafePathResolver`; reject mixed
  repositories and conflicting editable/read-only selections.
- [x] Build immutable per-turn snapshots and editable/read-only prompt chunks
  from current disk state.
- [x] Generate and inject repository maps when enabled, including current-turn
  filename and identifier hints.
- [x] Add a strategy registry for genuinely implemented modes and reject
  schema-only modes before a provider call.
- [x] Give each strategy its required system prompt, examples, reminders,
  shell-command policy, and fence selection instead of treating parsing alone
  as a complete mode.

**Acceptance:** the packed executable can start from config, environment, and
CLI inputs; select a supported provider/model/strategy; compose real repository
context; and complete both one-shot and serial interactive fake-provider turns.

**Startup verification (2026-09-10):** the focused application/interface suites
passed 35 tests; build, installed-bin watch startup/exit, packed fake-provider
startup, default optional-dependency absence, and executable help passed locally
on Linux. The final `npm run check` passed 276 tests (4 optional tests skipped).
The unified-diff property now restricts generated fixtures to its stated unique
hunk precondition; values such as `x` previously also matched the end of the
fixture's `prefix` line and made the randomized suite flaky. This is not a claim
of new cross-platform CI evidence.

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

**Acceptance:** Phase 3 and Phase 5 exits are demonstrated through the installed
application path, and tests prove the pinned lifecycle ordering.

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

**Local validation (Linux, 2026-09-10):** focused application/session/write/Git
suites passed 57 tests. `npm run check` passed formatting, lint, typecheck,
297 tests (4 optional skips), build, clean install, and package smoke including
`installed-lifecycle-ok`. `npm start -- --help` passed. No new cross-platform
or live-provider evidence is claimed, and this work is not pushed.

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

**Problem:** slash commands currently produce inert typed effects. Clipboard
commands were added to the parser but are likewise not connected to terminal or
session state.

- [x] Add an application-owned dispatcher for `/add`, `/drop`, `/read-only`,
  `/ls`, `/clear`, `/model`, `/chat-mode`, `/run`, `/test`, `/lint`, `/commit`,
  `/undo`, `/copy`, `/paste`, and `/exit`.
- [x] Resolve and authorize command paths through the same containment boundary
  as model edits; never mutate session lists from raw parser strings.
- [x] Rebuild provider/strategy state safely for `/model` and `/chat-mode`,
  preserving or summarizing compatible history as documented.
- [x] Add an interactive CLI approver for `/run`; `/lint` and `/test` use only
  configured process adapters at the repository root. `/run` shares the terminal
  approver used for model commands and writes; outside standalone interactive
  TTY mode it defaults to denial unless an embedding caller injects approval.
- [x] Constrain `/commit` and `/undo` to selected paths and Patch-created commit
  markers without disturbing unrelated user changes.
- [x] Connect `/copy` and `/paste` to text-only clipboard adapters with clear
  unavailable-platform errors.
- [x] Serialize commands and provider turns through the same session queue and
  test commands submitted while a turn is active.

**Acceptance:** every command shown in help/documentation has an executable
effect or is removed from the advertised surface; parser-only behavior is not
marked complete in the porting plan.

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

**Acceptance:** Phase 4's exit statement is backed by executable, opt-in tests
rather than only mocked Fetch responses.

## R5 — Add cross-platform CI and package evidence

- [x] Run format/lint/typecheck/unit tests once on Linux and run platform-sensitive
  integration/package jobs on Linux, macOS, and Windows with Node.js 22.
- [x] Cover path separators, symlinks or their documented Windows substitute,
  Git worktrees, process cancellation, shell argv, history permissions,
  external editor cleanup, notifications, clipboard detection, and package bins.
- [x] Run repository-map extraction for every shipped language from the packed
  package on all supported platforms.
- [x] Run explicit PTY tests only in jobs that provision the optional native
  dependency; verify Ctrl-C, EOF, resize, cleanup, and hostile split control
  sequences on Linux and Windows. macOS PTY is explicitly unsupported after the
  provisioned native package failed its spawn contract.
- [x] Add deterministic timeout guards and retain useful diagnostics without
  exposing environment secrets.

**Acceptance:** platform-sensitive Phase 6 and Phase 8 exit claims have green
Linux/macOS/Windows evidence or are narrowed to the platforms actually tested.

## R6 — Wire and verify advanced strategies

- [x] Implement a complete mode registry for `help`, `diff-fenced`, `udiff`,
  `udiff-simple`, `patch`, `architect`, `editor-diff`, `editor-diff-fenced`,
  `editor-whole`, and `context`, or remove unsupported values from user-facing
  schemas and model settings.
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
- [x] Stream provider output through `MarkdownStream`, render authorized edit
  previews through `renderDiff`, and honor TTY, `NO_COLOR`, and `--no-color` in
  the executable.
- [ ] Dispatch interactive commands through `runPtyCommand` only when explicitly
  requested and available; keep noninteractive process execution portable.
- [ ] Wire shell completions, notifications, and clipboard effects to the same
  command/application state used by the session.
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
- [x] Connect `AiWatchMode` to concrete sessions and Git ignore handling, sharing
  the exact session mutation queue. CLI watch shares the terminal session;
  web sessions use that same concrete session implementation independently.
- [x] Add supported startup/configuration for the authenticated loopback web
  server and construct it with the real `ApplicationService`. Interface choices
  are explicit CLI flags; model/file settings retain staged configuration.
- [ ] Define session expiry, shutdown, backpressure, bounded event buffering,
  and cancellation behavior for HTTP/SSE sessions.
- [x] Expose voice transcription as explicit input to an application session
  without importing voice code from the root/CLI path or requiring ffmpeg at
  install time.
- [ ] Test principal/session isolation, simultaneous terminal/watch/web work,
  disconnect cancellation, adapter cleanup, and optional dependency absence.

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
- [x] Audit every Phase 0–9 checkbox. Uncheck or label partial all items that are
  parser/adapter/schema-only, lack application wiring, lack required platform or
  live-provider evidence, or fail their phase exit.
- [x] Correct Phase 3/5 lifecycle and usable-release exits until an installed
  binary passes the full workflow test.
- [x] Correct Phase 6 cross-platform and Phase 7 independent-golden claims until
  the required evidence exists.
- [x] Correct Phase 8/9 checkboxes and default-install-footprint exit until the
  helpers are integrated and native dependency assertions pass.
- [x] Reconcile `CHANGELOG.md` wording with what users can invoke, reserving
  “support” and “parity” for behavior reachable through a documented interface.
- [x] Ensure every directly ported file identifies its upstream path, pinned
  revision, modification, and Apache-2.0 provenance as required.

**Acceptance:** a reader can derive the exact shipped behavior, unsupported
behavior, test evidence, and remaining work without inspecting source code.

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
- [ ] one-shot and multi-turn fake-provider sessions;
- [ ] edit preview, authorization denial/acceptance, dirty checkpoint, apply,
  commit, lint, approved shell command, test reflection, and undo;
- [ ] exact file and Git state after cancellation or every injected failure;
- [ ] every advertised slash command through the application dispatcher;
- [ ] repository-map context through the packed executable;
- [ ] live provider contracts in the protected opt-in workflow;
- [ ] Linux, macOS, and Windows package/platform jobs;
- [ ] default packed installation with no native/browser/audio dependency; and
- [ ] explicitly provisioned PTY and optional-interface suites.

Record the exact test files/workflows next to each corrected phase exit. A green
unit test for an exported helper is evidence for that helper, not for an
installed-application parity claim.
