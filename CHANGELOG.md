# Changelog

All notable changes to Patch will be documented in this file.

The project has not published a release yet.

## [Unreleased]

Items under **Added** inventory tested components and contracts. They are not a
claim that every component is reachable through the CLI; **Changed** and the
porting plan distinguish composed behavior from library-only adapters.

### Added

- Initial project overview and development status.
- Patch wordmark and icon assets.
- A phased TypeScript, Node.js, and npm porting plan covering architecture,
  implementation tasks, compatibility testing, security risks, and release
  criteria, pinned to aider commit `5dc9490b`.
- Contributor guidance for implementation, verification, attribution, asset
  placement, required documentation maintenance, and commits after every
  completed task.
- TypeScript and npm project foundations with strict type checking, linting,
  formatting, tests, build output, package validation, and a minimal CLI.
- Apache-2.0 licensing, upstream attribution guidance, and machine-readable
  aider source revision metadata.
- Node.js 22 continuous integration for formatting, linting, type checking,
  tests, builds, and clean installation of the packed executable.
- A deterministic, revision-checked upstream fixture exporter covering config
  precedence, message chunks, SEARCH/REPLACE behavior, Git diffs, and repository
  maps without adding Python to the runtime package.
- Strict runtime schemas and inferred TypeScript contracts for messages,
  provider streams, edits, repositories, commands, model settings, and session
  state.
- A validated, deterministic fake provider for testing streamed text,
  reasoning, fragmented tool calls, usage, errors, truncation, retries, and
  cancellation without network access.
- Canonical, root-contained path resolution that rejects traversal, escaping
  symlinks, dangling symlinks, and out-of-root existing or missing targets.
- Encoding-aware text reads and atomic writes with line-ending and byte-order
  mark preservation, dry-run previews, permission retention, and containment
  revalidation before replacement.
- Pinned common prompt resources and source-aware fence selection with exact
  compatibility fixtures for candidate order, collisions, and fallback.
- Validated chat chunks with upstream-compatible role ordering, immutable cache
  marking, defensive output copies, and normalized provider cache boundaries.
- Staged configuration bootstrap with Git CLI root discovery, ordered Patch
  config and dotenv searches, strict final argument parsing, and one-pass root
  correction for files selected from another repository.
- Validated YAML configuration with explicit precedence across defaults, home,
  repository, working-directory and explicit config files, environment,
  dotenv, and command-line values.
- A packaged, validated model catalog with aliases, YAML settings, commented
  JSON5 metadata, deterministic overrides, and clean-install resource checks.
- A provider-neutral edit-strategy contract and an `ask` strategy that cannot
  emit file edits or shell commands.
- Whole-file fenced-block parsing with upstream-compatible filename inference,
  reliability ordering, duplicate suppression, and trailing-newline behavior.
- SEARCH/REPLACE parsing and pure application with shell-block separation,
  exact and indentation-aware matching, paired elision, ambiguity rejection,
  and contextual failure diagnostics.
- Pure edit-batch dry-run resolution against immutable file snapshots, with
  sequential same-file edits and all-or-nothing failure results.
- Explicit resolved create, update, and delete operations, including
  deterministic move expansion and original content for stale-write protection.
- Transactional edit staging that validates every path, snapshot, and encoded
  result before authorization or writes, then revalidates before commit.
- Property-based edit-engine coverage for malformed fences, repeated matches,
  empty files, Unicode, CRLF, duplicate filenames, and traversal attempts.
- An initial `CoderSession` that composes injected provider and edit-strategy
  contracts through validated parsing, dry-run resolution, and edit staging.
- Session turn preparation and finalization with ordered prompt chunks,
  conservative token budgets, response validation, and atomic history updates.
- Provider-event streaming with response/reasoning assembly, usage tracking,
  bounded exponential retries, cancellation, context overflow, and truncation.
- Bounded corrective reflection for malformed edits and library-level injected
  lint/test diagnostics, now also composed with post-write application checks.
- File-mention detection with an approval hook for new or unselected paths;
  interactive CLI approval is not composed yet.
- Atomic model/provider/strategy switching with state transfer and removal or
  summarization of history that uses an incompatible edit format.
- CLI one-shot `--message`, `--message-file`, and serial interactive line input.
- OpenAI-compatible Chat Completions streaming through the official npm client,
  including custom endpoints, usage, finish reasons, and classified failures.
- Anthropic Messages streaming with system-message separation, ephemeral cache
  controls, multimodal blocks, thinking, tools, usage, and stop-reason mapping.
- Non-recursive main, weak, and editor model selection with explicit role and
  editor-format overrides.
- Secret-safe provider credential and model/adapter capability preflight
  diagnostics.
- Model-aware OpenAI token counting with explicitly labeled conservative
  estimates for unknown and multimodal prompts.
- Usage reports with provider or catalog cost attribution and explicit unknown
  pricing instead of misleading zero-cost estimates.
- A documented provider compatibility table and strict live-provider factory
  that rejects unsupported providers before network access.
- Canonical common-Git-worktree discovery for existing and future selected
  paths, with mixed-repository selections rejected.
- A Git CLI repository adapter with NUL-safe status parsing, tracked files,
  combined diffs, ignore rules, and unborn/detached HEAD support.
- A write-boundary component that previews staged operations, defaults to
  denying new and out-of-chat files without an injected authorization callback,
  checkpoints dirty inputs, and reports changed paths.
- Selected-file Git commits with hook control, identity/co-author attribution,
  injected message generation, and marker-constrained undo.
- Child-process-only Git identity overrides that leave global environment state
  unchanged.
- Runtime-validated parsing for the MVP file, model, process, Git, and lifecycle
  slash commands, including quoted paths and strict argument handling.
- An explicit approval port for model-suggested shell execution, with exact
  previews, repository-root working directories, bounded output, timeout, and
  cancellation; standalone TTY approval is now composed as described below.
- Optional configured lint and test command adapters with config, environment,
  and CLI precedence; absent commands remain disabled instead of guessing a
  target repository's package-manager invocation.
- Version-pinned Tree-sitter WASM grammars and attributed repository-map tag
  queries resolved as packaged runtime resources outside branding assets.
- Root-contained `web-tree-sitter` definition/reference extraction with
  deterministic source locations and unsupported-language handling.
- Initial JavaScript, TypeScript/TSX, Python, Go, and Rust repository-map
  language support with pinned grammar/query tests.
- Deterministic weighted reference-graph ranking with personalized PageRank,
  identifier heuristics, and chat-file weighting.
- Syntax-aware tree-context rendering with compact scope headers, elisions,
  long-line limits, and strict token-budget binary search.
- Atomic mtime/size/content-keyed tag caches with corruption recovery and
  `manual`, `always`, `files`, and adaptive `auto` map refresh modes.
- Pinned aider compatibility fixtures for repository-map tags, definition rank
  order, normalized context rendering, and token ceilings.
- Clean-install npm package smoke coverage that loads packaged queries and WASM
  grammars and extracts JavaScript, TypeScript, Python, Go, and Rust tags.
- Fenced SEARCH/REPLACE as an independent prompt protocol over the shared diff
  parser and matcher.
- Fenced unified-diff parsing and pure hunk application with distinct missing
  and non-unique context diagnostics.
- Typed patch add, delete, update, and move actions with exact, trailing-space,
  and surrounding-space fuzz accounting.
- Library-only architect/editor orchestration with explicit acceptance and an
  independently configured editor contract.
- Library-only context file selection with order-independent convergence, a
  strict iteration bound, and cancellation through deterministic provider turns.
- Library-only capability-gated prompt-cache, keepalive, assistant-prefill, and
  read-only image/PDF context contracts.
- A deterministic, terminal-library-neutral command, repository-file, and Unicode
  identifier completion with command-aware candidates and quiet short-prefix
  behavior.
- Opt-in persistent input and chat history with explicit CLI paths, multiline
  JSONL input records, Markdown transcripts, private creation modes, and
  retention and secret-exposure documentation.
- Executable tagged and EOF multiline input plus library-only declarative Emacs/
  Vi keybindings and shell-free external-editor invocation.
- Incremental Markdown rendering, lightweight fenced-code syntax highlighting,
  colored diff previews, hostile escape stripping, and TTY/`NO_COLOR`/CLI
  no-color behavior without a rendering dependency.
- A library-only optional native `node-pty` adapter with argv commands, resize,
  Ctrl-C, EOF, cancellation cleanup, and stateful child control-sequence
  sanitization while preserving a portable default installation.
- Bash, Zsh, and Fish completion generation, opt-in bell or argv-command
  notifications, and text-only clipboard commands backed by optional platform
  utilities with image/native enhancements explicitly optional.
- DNS-pinned, redirect-revalidated URL fetching with SSRF protection, textual
  content checks, byte and time limits, cancellation, and dynamically loaded
  optional Playwright rendering.
- A safe `AI!`/`AI?` watch adapter with built-in and injectable ignore rules,
  bounded reads, debounce, cancellation, and serialized session submission.
- A loopback-only authenticated HTTP/SSE adapter over a shared application
  service, with constant-time bearer checks and per-principal/session isolation.
- An optional voice-input package subpath with bounded temporary recordings,
  cancellation, injected recorder/transcriber ports, ffmpeg/OpenAI adapters, and
  explicit `ApplicationSession` submission.

### Added

- Transient provider failures are classified by HTTP status in both adapters:
  408, 429, 409, and any 5xx — including the 529 overload some providers return
  — are retried, while a request the server rejected as malformed is not. A
  chunk that fails schema validation is now a retryable provider error rather
  than an immediate turn failure. Previously every one of these fell through as
  a non-retryable provider error, so a single upstream hiccup ended the turn.
- Catalog metadata is folded into the model settings a session uses, so the
  bundled limits, prices, and capability facts reach the token budget and cost
  reports instead of being returned alongside and ignored. Metadata wins for the
  fields it defines and capabilities merge key by key.
- A `useTemperature` policy: `false` sends no temperature for models that reject
  it, `true` (the default) sends a deterministic `0`, and a number sends that
  value. Requests previously carried no temperature at all, leaving sampling to
  each endpoint's own default. `deepseek/deepseek-reasoner` sets `false`.
- Automatic summarization of long chat history. Completed history grew without
  bound until a turn failed the token budget; it is now summarized before the
  turn whenever it exceeds the model's `maxChatHistoryTokens` (1024 by default),
  keeping the most recent messages verbatim and compacting the rest with the
  active model's weak model. A summarizer that fails leaves history untouched
  rather than failing the turn.
- Model-configured reasoning-tag normalization. A model whose settings carry a
  `reasoningTag` — `deepseek/deepseek-reasoner`, aliased `r1`, is the bundled
  one — reasons inside the ordinary content stream, and that span is now split
  out as it arrives and re-emitted as reasoning, so the tagged text never
  reaches the terminal, history, or the edit parser. A tag broken across
  provider deltas is still recognized, and a response whose closing tag has no
  opening tag is cleaned once it is complete.

### Fixed

- Surfaced watch-mode failures and refreshed every selected file's AI comments
  on a trigger. A watched turn that failed and a native watcher error were both
  discarded, so a background failure and a dead watcher were invisible behind
  the input loop; both now reach the terminal through `onError`. A triggered
  turn also rereads AI comments from every file in the chat, so a comment
  written earlier in another selected file is no longer dropped because only one
  file changed.
- Isolated per-file failures during repository-map construction. One tracked
  path that was deleted, unreadable, or unparseable aborted the whole turn that
  asked for the map; such a path is now dropped from the map and reported by
  `RepositoryMap.skippedPaths`.
- Sent the editable-files prompt as the user/assistant pair Aider defines. A
  turn with no editable files sent no editable-files section at all, so the
  model was never told that no file was shared; it now receives
  `filesNoFullFilesWithRepoMap` and its reply when a repository map is present
  and `filesNoFullFiles` otherwise, and the file-contents case carries its
  assistant acknowledgement.
- Reconciled history and reported a structured outcome when a turn fails or is
  cancelled after its edits already reached the worktree. Such a turn was
  discarded entirely, so the next turn saw changed files with no record of the
  request or response that changed them, and the caller received an error naming
  neither the changed paths nor the commit. Writes and checkpoint/apply commits
  are now reported to the session, an interrupted turn whose work survives keeps
  its user message, reflection exchanges, and model response, and the rejection
  is wrapped in `TurnPartiallyAppliedError` carrying `changedPaths`, `commit`,
  and `commands`. A turn that changed nothing still leaves no history and its
  error is rethrown unchanged.
- Built the package from a clean `dist/` on every `npm pack`, `npm publish`, and
  Git-URL install through a `prepack` script, rather than packaging whatever
  build output happened to be on disk. The package smoke test now also asserts
  the tarball carries both entry points, the three model resource files, and the
  repository-map resources, so a missing runtime resource fails before
  publication instead of at a user's first turn.
- Rejected unsupported startup shapes by name instead of leaking the underlying
  failure. Starting outside a Git worktree reported a bare
  `git rev-parse --show-toplevel` failure; it now says Patch could not open a
  worktree there and names `--no-git`. Passing a directory to `--file`,
  `--read-only`, `/add`, or `/read-only` failed later as
  `EISDIR: illegal operation on a directory`; it is now refused at selection.
  Paths that do not exist yet remain selectable.
- Normalized DeepSeek requests for that endpoint instead of sending OpenAI's
  spellings. `OpenAIProvider` takes a `deepseek` dialect, selected by
  `createProvider` from the model's provider, that strips the `deepseek/`
  routing prefix from the model name, sends the output limit as `max_tokens`,
  and marks a trailing assistant message `prefix: true` on the endpoint's
  `/beta` path so a truncated turn can actually continue.
- Retained a final usage event that arrives after the finish event. The turn
  loop stopped reading as soon as a provider finished, so the usage chunk
  OpenAI-compatible endpoints send last was dropped and token and cost
  accounting silently stayed at zero. The stream is now drained past finish,
  and only usage is accounted after it.
- Submitted `/paste` clipboard text as a user turn instead of displaying it as
  an application response. The text becomes the turn message verbatim and is
  never reparsed as a command, so clipboard content the user did not write
  cannot dispatch `/run` or any other effect, and an empty clipboard is rejected
  rather than submitted as a blank turn.
- Rebuilt every model-derived input when `/model` or `/chat-mode` switches, and
  installed it as one value. The system prompt, examples, reminder, shell
  policy, fence, and repository-map policy previously kept describing the
  startup model, so switching to a whole-file model still asked for
  SEARCH/REPLACE blocks; `/chat-mode code` returned to the startup model's edit
  format rather than the active model's, and discarded an explicit
  `--edit-format`. The new profile is installed only after the session accepts
  the switch, so a failed provider construction or a rejected switch leaves the
  previous model, prompts, and policies in place. File messages are now wrapped
  in the selected fence instead of literal triple backticks, and history drops
  image or document parts a replacement model cannot accept.
- Serialized repository mutations across every application session sharing one
  worktree. A re-entrant worktree lock orders each session's checkpoint, apply,
  commit, configured checks, approved commands, and undo, so terminal, watch,
  and local HTTP/SSE sessions can no longer interleave mutations on one
  checkout. Provider streaming still runs concurrently, and a turn whose edits
  resolved against content another session changed fails on the stale snapshot
  instead of overwriting it. Separate processes remain ordered only by Git's
  own index lock.
- Applied one stateful control-sequence sanitizer to every untrusted terminal
  output path rather than PTY child output alone: streamed model text, rendered
  diffs and edit previews, both Commander streams, and executable failure
  messages. Sequences split across provider deltas can no longer rejoin, and
  C0 controls, DEL, the C1 range, 8-bit CSI/OSC, DCS/SOS/PM/APC strings, single
  shifts, and escapes with intermediate bytes are all removed.
- Completed the replacement metadata and ancestor policy: a replaced file keeps
  its permission bits and, where the process is permitted, its owner and group;
  identity comparison now includes ownership; and the containing directory's
  device and inode are rechecked immediately before every rename or unlink, so a
  directory swapped for a different one at the same path is refused instead of
  silently mutated. Attributes Node cannot carry portably through a rename —
  ACLs, extended attributes, file flags, and alternate data streams — are
  documented as not preserved rather than implied.
- Treated a path whose ancestor is not a directory as missing rather than
  raising a raw `ENOTDIR`, so resolution, reads, snapshots, and edit staging
  agree on absence; creating such a path still fails, keeping a move source
  intact.
- Bound `/undo` to the commit the current session created and moved HEAD with a
  compare-and-swap `update-ref`. Root commits, merge commits, and commits their
  upstream branch already contains are refused instead of reset.
- Followed every `--- `/`+++ ` header transition inside a unified-diff fence, so
  a second file's hunks target that file instead of being folded into the
  previous file's hunk, and stripped git path prefixes only when both headers
  carry them.
- Implemented named Patch `@@` scope anchors and Aider's per-path action rules:
  repeated `Update File` blocks merge with an overlapping-chunk check, and
  duplicate adds, conflicting add/delete/update combinations, and a second move
  target are rejected. A repeated delete is still ignored as redundant.
- Ordered edit-transaction commits so every creation and update is written and
  synced before any deletion, and rechecked each deletion's resolved content
  immediately before removing it. An interrupted move now keeps both paths, and
  a case-only rename on a case-insensitive filesystem is refused instead of
  deleting the moved file.
- Rejected replacement and deletion of hardlinked or non-regular files and
  added an immediate pre-mutation identity recheck. This intentionally hardens
  pinned Aider's direct-write behavior without claiming full ancestor-race or
  metadata preservation.
- Raised only the real-Git reflection-limit test timeout to accommodate Windows
  process startup across four full attempts without changing runtime limits.
- Made repository-map and new-file tests assert the documented native path and
  line-ending behavior instead of assuming POSIX output on every platform.
- Scoped Vitest to source tests and made builds remove stale `dist/` content;
  package smoke validation now rejects tarballs that contain compiled tests.
- Added a repository line-ending policy so Windows checkouts with
  `core.autocrlf=true` no longer fail the Phase 0 Prettier validation gate solely
  because Git materialized tracked text files as CRLF.
- Unified-diff application now distinguishes whitespace-only source lines from
  empty hunk sides used by pure additions and deletions.
- Made repository adapter subprocesses that accept selected pathspecs set
  `GIT_LITERAL_PATHSPECS=1`, so names containing Git wildcard syntax cannot
  expand to unrelated files during diff, stage, commit, or undo operations.
  `check-ignore` retains its exact-pathname mode because that Git command rejects
  literal-pathspec magic. A real-repository regression test and compiled-adapter
  smoke scenario cover a literal `[ab].txt` beside `a.txt`.
- Filtered selected and tracked paths through batched, NUL-delimited
  `git check-ignore` calls before file snapshots, mention matching, repository
  maps, or provider messages. Explicit selections, slash-command additions, and
  model edits targeting ignored files now fail before content is read; focused
  Git, startup, and compiled-service scenarios cover tracked `.aiderignore`
  content.

### Changed

- Revalidated the Phase 0 exit on Windows after a clean lockfile install: all
  default checks, 333 source tests, clean build, package install, installed
  lifecycle smoke, and installed CLI help passed without Python.
- Re-audited Patch `58597efc3` against pinned Aider `5dc9490b` across lifecycle,
  editing, providers, configuration, Git/filesystem, repository maps, terminal,
  interfaces, packaging, and provenance. Corrected current documentation and
  recorded the release-blocking and core-workflow gaps in the authoritative
  integration backlog. Contributor guidance now requires agents to preserve
  this production-path distinction and re-audit touched subsystems; no
  application behavior changed in this audit.
- Connected one terminal input owner to new/out-of-chat write authorization,
  model command approval, and `/run`. Standalone TTY sessions show escaped,
  exact literal previews and accept only `y`/`yes`; empty/ambiguous answers,
  EOF, Ctrl-C, and pre-existing queued/partial input deny. Answers never enter
  model input or persistent history. Other input modes retain deny-by-default
  behavior. Concrete executable-program tests cover file/process effects and
  gating; native PTY approval coverage and broader approval policies remain open.
- Integrated dry-run resolution and post-write lint/test reflection into the
  concrete turn's shared three-reflection budget, refreshing disk context and
  token budgets between attempts. Check commits are recorded before reflection
  and retained on later failure. Configured check failures currently reflect
  automatically; aider's per-failure confirmation remains unimplemented.
- Revalidate staged snapshots after approval and before checkpointing, observe
  cancellation at mutation boundaries and between writes, authorize against
  the live file selection, and reject read-only aliases. Multi-file failures
  retain completed writes; no rollback or exhaustive cancellation is claimed.
- Preserve unrelated index entries during `/undo`, while retaining working
  files and earlier commits. Added asymmetric installed-service acceptance
  and real-Git failure/cancellation tests. Interrupted-history reconciliation
  remains incomplete.
- Added opt-in `--watch-files` terminal startup and standalone
  `--web --web-token-file` loopback HTTP/SSE startup using the concrete service.
  Watch shares terminal state and Git ignore handling; question-only `AI?`
  submissions suppress writes and commands. Web tokens stay out of output,
  malformed JSON returns 400, and startup failure/shutdown closes adapters and
  cancels/drains concrete sessions. Packed startup tests retain the native- and
  browser-free default install. Web expiry, quotas, bounded SSE backpressure,
  and concurrent cross-session repository coordination remain unsupported.
- Added the concrete application composition root used by the CLI, including
  staged configuration, model/provider selection, safe current-file context,
  repository maps, implemented strategy dispatch, and per-session serialization.
- Connected staged edit previews, write authorization, dirty-file checkpoints,
  selected-path commits, approved model commands, and post-write lint/tests in
  the application lifecycle. Multi-file filesystem rollback remains unsupported.
- Dispatched every parsed slash command through concrete session state,
  including contained file selection, model/mode switches, approved processes,
  constrained Git operations, text clipboard actions, and clean exit.
- Added protected, manually dispatched low-cost live contracts for OpenAI,
  Anthropic, and the advertised DeepSeek-compatible endpoint; normal tests stay
  credential-free and mocked.
- Expanded CI package and platform-sensitive contracts to Node.js 22 on Linux,
  macOS, and Windows, including linked Git worktrees and separately provisioned
  PTY jobs on supported platforms.
- Made platform assertions compare canonical paths, limited POSIX permission
  assertions to POSIX hosts, and made npm/package-bin smoke invocation portable
  on Windows, including command-shim execution through the platform shell.
- Restricted unified-diff property fixtures to genuinely unique hunks so random
  values that also match a context-line suffix no longer make the suite flaky.
- Narrowed explicitly provisioned PTY support to Linux and Windows after the
  native package failed its spawn contract on GitHub's macOS runner.
- Narrowed CLI/config edit formats to the six modes the application actually
  constructs; advanced orchestration helpers are no longer accepted as if they
  were complete user-facing modes.
- Connected executable application output to safe incremental Markdown and
  staged diff rendering, including TTY, `NO_COLOR`, and `--no-color` handling.
- Added an opt-in voice-subpath bridge that submits bounded transcripts through
  an explicit application session without changing the default install path.
- Removed `node-pty` from the default dependency graph. Interactive PTY users
  now install it explicitly, while normal installs remain native-free.
- Updated the project overview to link the porting plan and accurately describe
  the current foundation-stage implementation.
