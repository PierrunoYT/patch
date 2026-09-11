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
| Core lifecycle | partial | Ordinary initial turns are composed and model/mode switching now rebuilds the whole profile atomically; failed-mutation history, continuation, and multi-session ownership are incomplete. |
| Editing | partial | Whole-file, basic SEARCH/REPLACE, and Patch multi-action handling are strongest; unified-diff still has unsafe multi-file cases. |
| Models/providers | partial | OpenAI and Anthropic basic streaming routes exist, DeepSeek requests are normalized, and post-finish usage is retained; metadata merging, temperature policy, and retry breadth are incomplete. |
| Git/filesystem | partial with intentional hardening | Literal pathspecs, ignored-context filtering, static containment, staging, and selected commits are strong; move ordering, session-owned undo, cross-session mutation ordering, portable metadata preservation, and ancestor-swap detection are now enforced, with the remaining metadata and race limits documented as intentional. |
| Repository maps | partial | An eleven-language production map exists, per-file failures are isolated, the budget is model-aware, and unparsed files contribute lexical references; context mode and fixture breadth are incomplete. |
| Commands/terminal | partial | Sixteen commands dispatch, switching and paste are correct, and rich input plus explicitly requested PTY dispatch are connected to the reader; path/glob selection, visible subprocess output, and URL ingestion are incomplete. |
| Watch/URL/web/voice/help | partial or missing | Watch and local HTTP/SSE start and now share one worktree mutation lock, and watch reports its failures and refreshes every selected file's AI comments; URL/voice are helper surfaces, browser GUI/help are absent, and web session policy (expiry, quotas, disconnect cancellation) is unfinished. |
| Configuration/package/provenance | partial | The supported bootstrap subset is staged, non-repository startup and directory targets are clearly rejected, and `--vim` is refused instead of ignored; the completion inventory, installed docs, and provenance checks remain. |

### Immediate P0 blockers

All immediate P0 blockers and all P1 correctness work are now closed; the P2
work below is what remains before the release claims can be re-audited.

- [x] Make every Git path argument literal so pathspec magic cannot stage,
  commit, diff, or undo unrelated files.
- [x] Filter tracked `.aiderignore` paths before snapshots, mention matching,
  repository maps, or provider requests.
- [x] Preserve move sources until destinations are durably created. `commit`
  writes and syncs every creation/update before any deletion and rechecks each
  deletion's resolved content immediately before the unlink, so an interrupted
  move or a case-only rename cannot leave the content deleted.
- [x] Reject or correctly implement named Patch `@@` scopes, repeated actions,
  and conflicting actions for one path. Scopes advance the search cursor or are
  rejected, repeated update blocks merge with an overlap check, and duplicate or
  conflicting add/delete/move actions are rejected as upstream does.
- [x] Parse every unified-diff file-header transition. A `--- `/`+++ ` pair
  inside a fence closes the pending hunk and retargets the following hunks, and
  git prefixes are stripped only when both headers carry them.
- [x] Bind undo to a commit owned by the current session and recheck HEAD
  atomically before reset. `/undo` reverts only the commit this session
  recorded, and `update-ref` performs a compare-and-swap on HEAD. Root, merge,
  and already-pushed commits are refused.
- [x] Serialize repository mutations across application sessions, especially
  local HTTP/SSE sessions sharing one worktree. A re-entrant
  `WorktreeMutationLock`, held process-wide per resolved root, wraps every
  region that observes or changes the worktree: the checkpoint/apply/commit/
  lint/command/test phase of a turn, each Git commit, each configured check,
  an approved `/run`, and the check-and-reset pair behind `/undo`. Streaming
  stays outside the lock. Separate processes on one worktree remain ordered
  only by Git's own index lock, which is documented as a limit rather than a
  guarantee.
- [x] Apply one stateful sanitizer to all untrusted terminal output, not only
  PTY child output. `ControlSequenceSanitizer` now lives in `src/io/sanitize.ts`
  and is used by PTY output, `MarkdownStream` (one instance per stream, so a
  sequence split across provider deltas cannot rejoin), every one-shot render
  path through `stripAnsi`, both Commander output streams, and the executable's
  failure messages. It removes C0 controls other than tab/newline/carriage
  return, DEL, the C1 range, 7-bit and 8-bit CSI, OSC/DCS/SOS/PM/APC strings
  with either terminator, single shifts, and escapes carrying intermediates.
- [x] Complete the metadata and ancestor check-to-use policy for replacement and
  deletion. Replacement now carries mode bits and, where the process is
  permitted, owner and group; identity comparison includes ownership. The
  containing directory's device and inode are captured when a mutation is
  prepared and rechecked immediately before the rename or unlink, so a
  directory swapped for a different one at the same path is refused with
  `AncestorChangedDuringWriteError`. ACLs, extended attributes, file flags, and
  alternate data streams are documented as not preserved — Node exposes no
  portable API for them, and preserving them would mean in-place writes and
  partial content — and the residual check-to-use window is documented as
  detection rather than prevention. Evidence: `tests/filesystem-ancestor.test.ts`
  and the ownership case in `tests/filesystem.test.ts`; policy in
  `docs/filesystem-safety.md`.

### Next P1 correctness work

- [x] Atomically switch the active model and complete strategy definition;
  rebuild prompts, shell policy, fence, map policy, and compatible history.
  `/model` and `/chat-mode` build a whole `SessionProfile` — main model, the
  format `/chat-mode code` returns to, strategy definition, reselected fence,
  and the repository map the new model's `useRepoMap` requires — and install it
  only after `CoderSession.switch` accepts the change, so a failed provider or a
  rejected switch leaves the previous model active. The selected fence now wraps
  file messages, and history drops media the replacement model cannot accept.
  Automatic history summarization stays P2. Evidence:
  `tests/application-prompt-context.test.ts` and the switch cases in
  `tests/coder-session.test.ts`.
- [x] Submit text returned by `/paste` as a user turn instead of displaying and
  recording it as assistant output. The clipboard text becomes the turn message
  verbatim and is never reparsed as a command, so clipboard content the user did
  not write cannot dispatch an effect; an empty clipboard is rejected. Clipboard
  images remain unread. Evidence: the paste cases in
  `tests/application-commands.test.ts`.
- [x] Normalize DeepSeek endpoint model/output parameters and prefill requests;
  retain final usage events through `CoderSession`. `OpenAIProvider` takes a
  `deepseek` dialect that strips the `deepseek/` routing prefix, sends
  `max_tokens` instead of `max_completion_tokens`, and marks a trailing
  assistant message `prefix: true` on the endpoint's `/beta` path;
  `createProvider` selects it from the model's provider. `CoderSession` drains
  the provider stream past the finish event, so the usage chunk OpenAI-compatible
  endpoints send after it is accounted instead of dropped. Metadata merging and
  temperature policy stay P2. Evidence: `tests/deepseek-provider.test.ts` and the
  post-finish usage case in `tests/coder-session.test.ts`.
- [x] Make default non-repository startup and a sole directory target explicit
  supported or clearly rejected workflows. Both are rejected, by name and with
  the alternative: startup outside a worktree reports that Git integration is on
  and names `--no-git`, rather than surfacing a bare `git rev-parse` failure, and
  a directory passed to `--file`, `--read-only`, `/add`, or `/read-only` no
  longer fails later as `EISDIR`. A path that does not exist yet stays
  selectable. Directory and glob expansion landed with the P2 selection item
  below, which replaced the interim rejection. Evidence: the startup rejection
  cases in `tests/interface-startup.test.ts`.
- [x] Add a clean `prepack` build/resource step before any publication claim.
  `prepack` runs `npm run build`, which cleans `dist/`, recompiles, and recopies
  the runtime resources, so `npm pack`, `npm publish`, and a Git-URL install all
  package a current build rather than whatever happened to be on disk.
  `scripts/package-smoke.mjs` asserts the tarball carries `dist/cli.js`,
  `dist/index.js`, the three model resource files, and the repository-map
  resources.
- [x] Reconcile history and structured partial results whenever files or commits
  survive a later failure or cancellation. The application reports each write and
  each checkpoint/apply commit through `CoderSession.recordTurnMutation()`, so an
  interrupted turn whose work survives appends its user message, reflection
  exchanges, and model response to history instead of being discarded, while a
  turn that changed nothing still leaves none. `submit()` wraps such a failure in
  `TurnPartiallyAppliedError`, which carries `changedPaths`, `commit`, and
  `commands` and names them in the message the terminal and HTTP interface
  print. A durable recovery journal and per-file partial-write results remain out
  of scope. Evidence: the reflection-limit case in
  `tests/application-lifecycle.test.ts` and the reconciliation case in
  `tests/coder-session.test.ts`.
- [x] Isolate missing/unreadable tracked files during map construction and emit
  the canonical no-editable-files prompt pair. `RepositoryMap.getMap` now catches
  per path: a tracked path that is gone, unreadable, or unparseable is dropped
  from the map and listed in `skippedPaths` instead of failing the turn that
  asked for the map. The editable-files chunk is a user/assistant pair in all
  three upstream shapes — file contents with the assistant's acknowledgement,
  `filesNoFullFilesWithRepoMap` with its reply when a map is present, and
  `filesNoFullFiles` with `Ok.` otherwise. Surfacing skipped paths to the user
  stays P2. Evidence: the isolation case in `tests/repository-map-cache.test.ts`
  and the prompt-pair cases in `tests/application-prompt-context.test.ts`.
- [x] Surface watch submission/native watcher failures and refresh all selected
  AI comments for a triggered turn. `WatchModeOptions.onError` receives both
  submission failures and native watcher errors, and the terminal prints
  `Watched turn failed` or `Watch mode stopped` with the reason instead of
  discarding it. Once a changed file triggers, `WatchModeOptions.selectedPaths`
  supplies the chat's files and their AI comments join the prompt, so a comment
  written earlier in another selected file is not dropped. Adding a changed file
  to the chat, as Aider does, stays out of scope because it would bypass path
  approval. Evidence: the refresh and failure-reporting cases in
  `tests/watch-mode.test.ts`.

### P2 parity and evidence work

- [x] Add automatic long-history summarization and model-configured reasoning-tag
  normalization before display, history, or edit parsing. `ChatSummary` ports
  aider's split-and-recurse algorithm and runs before every turn whose completed
  history exceeds the model's `maxChatHistoryTokens`, summarizing with the active
  model's weak model; a summarizer that fails leaves history untouched rather
  than failing the turn. `ReasoningTagSplitter` divides a `reasoningTag` model's
  content stream as it arrives, so the tagged span reaches neither the terminal,
  history, nor the edit parser, and a response whose closing tag has no opening
  tag is cleaned once complete. Evidence: `tests/chat-summary.test.ts`,
  `tests/reasoning-tags.test.ts`, and the summarization case in
  `tests/application-prompt-context.test.ts`.
- [x] Merge executable metadata limits/prices/capabilities, add temperature
  policy, broaden transient error classification, and render usage/cost.
  `ModelCatalog.resolve` folds metadata into the settings a session uses;
  `useTemperature` decides whether a request carries no temperature, a
  deterministic `0`, or an explicit value; `transientByStatus` retries 408, 429,
  409 and any 5xx in both adapters and treats an unreadable chunk as retryable;
  and `ApplicationTurnResult` carries the usage report and running session cost
  so the terminal prints one accounting line per turn. Evidence:
  `tests/model-metadata-merge.test.ts`, the classification case in
  `tests/openai-provider.test.ts`, the rendering case in `tests/render.test.ts`,
  and the accounting case in `tests/interface-startup.test.ts`.
- [x] Add important-root-file priority, per-file lexical reference fallback,
  model-aware map sizing, live inventory refresh, extractor-versioned caches,
  and broader language/query fixtures. `filterImportantFiles` ports aider's
  root-file list and those files are listed before ranked symbols;
  `lexicalReferences` gives files no grammar covers a place in the ranking graph;
  `repoMapTokens` sizes the budget from the model's input limit and widens it
  when nothing is in the chat; the tracked inventory is re-read per turn; the tag
  cache carries an extractor/query/grammar fingerprint; and Bash, C/C++, C#,
  Java, and Ruby were added with their upstream queries, bringing the production
  map to eleven languages. Context mode and Aider's fallback map requests stay
  out of scope. Evidence: `tests/repo-map-renderer.test.ts`,
  `tests/tag-extractor.test.ts`, `tests/repository-map-cache.test.ts`, and the
  inventory case in `tests/application-prompt-context.test.ts`.
- [x] Connect completion, opted-in history navigation, Emacs/Vi bindings,
  external editor, true multi-turn multiline input, and explicit PTY dispatch.
  Tab completes commands and the files selected at that keystroke;
  `--input-history-file` also seeds recall; Alt-Enter holds a line so a message
  spans lines with a bare Enter still submitting; Ctrl-X Ctrl-E edits the whole
  draft in `--editor`/`VISUAL`/`EDITOR` and returns the result to the prompt;
  and `/run --interactive` dispatches one user-typed, approved command through
  `runPtyCommand`, releasing and restoring the line reader around it. Vi modal
  editing is not implemented, so `--vim` is refused by name rather than ignored.
  Child output stays sanitized, so full-screen programs are out of scope.
  Evidence: `tests/input-editing.test.ts`, `tests/interactive-command.test.ts`,
  and the `--vim` case in `tests/cli.test.ts`.
- [x] Add contained path/directory/glob selection semantics and complete visible
  subprocess output/status without weakening Patch's authorization bounds.
  `expandSelection` resolves a directory or a `*`/`**`/`?`/`[...]` pattern to the
  files it covers: the walk starts at the pattern's fixed prefix inside the
  resolved root, skips symbolic links and `.git`, drops ignored matches, refuses
  an absolute glob, and is bounded by a file limit and a directory-entry limit,
  so widening a selection cannot reach outside the worktree, follow a link out of
  it, or pull ignored content into context. Every authorization step is
  unchanged: each expanded path still goes through `approvePath`, and a named
  path keeps its own diagnostics. `/run` now reports the command, both streams,
  the exit status, and truncation; a model-suggested command reports through
  `command-complete` as it finishes and configured checks through
  `lint-complete`/`test-complete`, all rendered by the terminal. Evidence:
  `tests/selection.test.ts`, the expansion case in
  `tests/interface-startup.test.ts`, the output cases in
  `tests/application-commands.test.ts` and `tests/render.test.ts`, and the event
  ordering case in `tests/application-lifecycle.test.ts`.
- [ ] Define URL ingestion and HTML-to-readable-text behavior; keep the strict
  SSRF/no-subresource policy as an intentional security difference.
- [ ] Decide explicit dispositions for Aider help, report, settings, browser GUI,
  voice UX, analytics, onboarding/OAuth, and update/release-note families.
  **This one is an open product decision, not an implementation gap**, and it is
  deliberately left unchecked until the owner makes the call. Each family below
  needs one of three dispositions recorded in `PORTING_PLAN.md`: *implement*,
  *deferred* (wanted, not scheduled), or *non-goal* (documented as intentionally
  absent, with the reason).

  | Family | Upstream source | What it would cost | Notes for the decision |
  | --- | --- | --- | --- |
  | `/help` | `aider/help.py` | Medium: needs an index over the bundled docs | Patch already ships `docs/`; a local search over them needs no network |
  | `/settings` | `aider/args_formatter.py` | Small: print resolved bootstrap | Bootstrap already resolves and validates every value |
  | `/report` | `aider/report.py` | Small: build a prefilled issue URL | Opens a browser, so it is a network/privacy surface |
  | Browser GUI | `aider/gui.py` | Large: a Streamlit-equivalent web UI | Patch already serves an authenticated local HTTP/SSE API |
  | Voice UX | `aider/io.py` voice loop | Medium: record/transcribe/submit | `src/interfaces/voice.ts` exists as a helper only |
  | Analytics | `aider/analytics.py` | Small to add, permanent to support | Sends usage data off the machine; weigh against Patch's privacy stance |
  | Onboarding/OAuth | `aider/onboarding.py` | Medium: OAuth flow plus model defaults | Patch deliberately requires an explicit model today |
  | Update/release notes | `aider/versioncheck.py` | Small: a version probe on startup | Network call on every start; weigh against startup cost and privacy |

  Nothing else in P2 depends on this decision, so the remaining items proceed
  without it.
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
- [x] Restrict test discovery to `tests/**/*.test.ts`, clean `dist/` before each
  build, and reject packed tarballs containing compiled tests.
- [x] Keep cross-platform assertions aligned with the pinned Aider relative-path
  behavior and Patch's platform-default newline policy for new files.
- [x] Use an explicit cross-platform timeout for the real-Git reflection-limit
  test while retaining the production reflection and subprocess limits.

**Acceptance:** a plain `npm install` of the packed tarball performs no native
build and contains none of the optional native/browser dependencies, while an
explicitly provisioned PTY test still passes. The Phase 0 validation commands
must also pass from a Windows checkout with automatic line-ending conversion
enabled; the formatting gate is verified under that configuration.

**Local evidence (2026-09-10):** Windows/Node.js `v24.18.0` with
`core.autocrlf=true` passed `npm ci` and the complete `npm run check` production
path: 333 source tests passed, four gated tests skipped, the clean build and
tarball install succeeded, and the installed lifecycle and CLI help ran without
Python. The separately provisioned PTY contract remains CI-gated as documented.

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
  (currently automatic for explicitly configured checks) and complete
  standalone-bin approval-driven acceptance. The successful installed-service
  path finalizes history, usage, changed paths, and latest commit correctly, and
  an interrupted turn whose edits survive now reconciles history and reports a
  structured partial outcome.
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
- [x] Constrain `/undo` to the current session's owned HEAD commit, selected
  paths, and supported ancestry/publication state without disturbing unrelated
  changes. Only the session's recorded commit is undone, root/merge/pushed
  commits are refused, and HEAD moves through a compare-and-swap.
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
- [x] Normalize the advertised DeepSeek catalog model and request fields through
  the same factory/session path used by the executable and live contract.
- [x] Preserve OpenAI-compatible usage events that arrive with or after finish.
  Exposing accurate usage/cost at the application boundary is still P2.
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

- [x] Connect command/file/identifier completion to live selected files,
  commands, and approved source content. Candidates are re-read per completion,
  so they follow `/add` and `/drop`; identifier candidates remain limited to the
  selected files' contents.
- [x] Load persistent input history for navigation and append input/chat records
  only after the correct lifecycle events; test explicit paths and disabled-by-
  default behavior. Recall is seeded only when `--input-history-file` is
  configured, and a damaged line is skipped rather than failing startup.
- [x] Apply Emacs/Vi bindings and external-editor invocation in the actual input
  loop rather than exposing declarative helpers only. Alt-Enter and Ctrl-X
  Ctrl-E are handled by the reader; Vi modal editing is refused instead of
  advertised, since Node readline cannot provide it.
- [x] Complete terminal output safety. One stateful sanitizer covers Markdown
  streaming, diff and preview rendering, Commander output, and executable
  failure messages, and it strips every claimed control-sequence family.
  Evidence: `tests/terminal-sanitizer.test.ts`.
- [x] Dispatch interactive commands through `runPtyCommand` only when explicitly
  requested and available; keep noninteractive process execution portable.
  `/run --interactive` is the only caller, the optional native package is loaded
  at that point and nowhere else, and an interface without a terminal refuses
  the command rather than running it unattached.
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
- [x] Coordinate repository mutations across independent web/application
  sessions that share one worktree. Every session created for one root shares
  the same mutation lock; `tests/worktree-serialization.test.ts` asserts that
  two sessions never interleave a mutation phase and that a conflicting
  concurrent write fails the losing turn instead of clobbering the winner.
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
