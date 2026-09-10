# Changelog

All notable changes to Patch will be documented in this file.

The project has not published a release yet.

## [Unreleased]

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
- Bounded corrective reflection for malformed edits and injected lint/test
  diagnostics, with failed response context retained for the next attempt.
- File-mention detection and mandatory approval for new or unselected paths
  before they can enter a session or staged edit transaction.
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
- A final write workflow that previews staged operations, authorizes new and
  out-of-chat files, checkpoints dirty inputs, and reports changed paths.
- Selected-file Git commits with hook control, identity/co-author attribution,
  injected message generation, and marker-constrained undo.
- Child-process-only Git identity overrides that leave global environment state
  unchanged.
- Runtime-validated parsing for the MVP file, model, process, Git, and lifecycle
  slash commands, including quoted paths and strict argument handling.
- Explicit per-command approval for model-suggested shell execution, with exact
  previews, repository-root working directories, bounded output, timeout, and
  cancellation.
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
- Architect/editor orchestration that exposes the completed plan and requires
  explicit acceptance before invoking an independently configured editor.
- Context-mode file selection with order-independent convergence, a strict
  iteration bound, and cancellation through deterministic provider turns.
- Capability-gated prompt cache boundaries and bounded keepalive, assistant
  prefill continuation, and read-only image/PDF context composition.
- Deterministic, terminal-library-neutral command, repository-file, and Unicode
  identifier completion with command-aware candidates and quiet short-prefix
  behavior.
- Opt-in persistent input and chat history with explicit CLI paths, multiline
  JSONL input records, Markdown transcripts, private creation modes, and
  retention and secret-exposure documentation.
- Tagged and EOF multiline input, declarative Emacs and Vi keybindings, and
  shell-free external-editor invocation with private temporary files and
  guaranteed cleanup.
- Incremental Markdown rendering, lightweight fenced-code syntax highlighting,
  colored diff previews, hostile escape stripping, and TTY/`NO_COLOR`/CLI
  no-color behavior without a rendering dependency.
- Optional native `node-pty` interactive execution with argv commands, resize,
  Ctrl-C, EOF, cancellation cleanup, and stateful child control-sequence
  sanitization while preserving a portable default installation.
- Bash, Zsh, and Fish completion generation, opt-in bell or argv-command
  notifications, and text-only clipboard commands backed by optional platform
  utilities with image/native enhancements explicitly optional.
- DNS-pinned, redirect-revalidated URL fetching with SSRF protection, textual
  content checks, byte and time limits, cancellation, and dynamically loaded
  optional Playwright rendering.
- Safe `AI!`/`AI?` file watching with built-in and repository ignore rules,
  bounded reads, debounce, cancellation, and serialized session submission.
- A loopback-only authenticated HTTP/SSE adapter over a shared application
  service, with constant-time bearer checks and per-principal/session isolation.
- An optional voice-input package subpath with bounded temporary recordings,
  cancellation, injected recorder/transcriber ports, and ffmpeg/OpenAI adapters.

### Fixed

- Unified-diff application now distinguishes whitespace-only source lines from
  empty hunk sides used by pure additions and deletions.

### Changed

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
  macOS, and Windows, including linked Git worktrees and explicitly provisioned
  PTY jobs on each platform.
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
