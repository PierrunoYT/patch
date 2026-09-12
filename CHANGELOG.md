# Changelog

All notable changes to Patch will be documented in this file.

The project has not published a release yet.

## [Unreleased]

Items under **Added** inventory tested components and contracts. They are not a
claim that every component is reachable through the CLI; **Changed** and the
porting plan distinguish composed behavior from library-only adapters.
Entries record milestones at the time they were made, not a consolidated current
status. Use `docs/remaining-integration-tasks.md` for the live backlog and the
dated parity audits for revision-specific evidence.

### Added

- A bounded local `/report [title]` issue draft with allowlisted Patch, Node.js,
  OS, architecture, and Git versions. The optional title is visibly marked as
  user input; unavailable or malformed metadata is omitted, and no diagnostics,
  browser, upload, provider, or network path is present.
- Executable source-identifier completion, refreshed on every Tab press from
  current selected non-ignored source. Available filenames are also refreshed;
  source contents remain behind the application boundary and ignored or
  out-of-root identifiers are never exposed.
- Authenticated local HTTP session policy with 30-minute idle expiry and
  reclamation; total, per-principal, pending-message, and SSE-client quotas;
  bounded SSE replay and slow-client queues; and stable expiry/quota/replay
  status codes.
- Production-route interface evidence for principal/session SSE isolation,
  active HTTP disconnect cancellation, forced slow-client overflow and replay
  recovery, concrete post-write error consistency, and simultaneous terminal,
  watch, and web mutations serialized by the shared worktree lock.
- An independently authored fixture pinned to aider `5dc9490b` for each of the
  six constructed edit formats, plus asymmetric properties and per-format
  malformed/ambiguous or conflicting, second-write failure, and between-write
  cancellation evidence. Generated upstream fixtures remain separately labeled.
- A machine-readable ledger for all identified direct Aider source/resource
  derivations, with a full-suite drift check for local/upstream paths, the pinned
  revision, modification notices, Apache-2.0 evidence, and packed documentation.
- Deterministic cancellation boundaries across context, provider, parsing,
  resolution, authorization, writes, Git, checks/reflection, and finalization,
  with exact partial-write/checkpoint evidence and reusable session queues.
- Exact selected-index restoration after failed Git commits, preserving partial
  staging, untracked status, and unrelated staged/unstaged work across
  checkpoint, edit, and configured-check paths.
- An immutable per-attempt lifecycle context that binds provider-visible file
  snapshots and authorization sets to parsing, resolution, writes, configured
  checks/reflection, commits, and final accounting.
- Explicit cleanup ownership across startup and switched providers, temporary
  weak-model streams, watchers, subprocesses, history writes, HTTP sessions,
  SSE clients, and server sockets on normal exit, failure, and cancellation.
- Staged YAML, `PATCH_*`, dotenv, and CLI configuration for input/chat
  histories, multiline input, notifications, watch mode, and the authenticated
  local web interface, including explicit CLI disable overrides and
  repository-root correction.
- Application-level bounded context selection with the pinned analyst prompt,
  forced map refresh, an expanded initial map budget, original-request
  identifier hints, complete editable-set replacement, explicit approval for
  newly selected paths, and atomic cancellation/non-convergence failure.
- Application-level architect proposal and editor handoff with explicit user
  acceptance. The architect is read-only, denial never constructs an editor,
  accepted edits use a fresh editor, and selected paths, usage cost, commit
  ownership, cancellation, and final architect history return to the parent.
- A production internal editor role using pinned editor-specific whole-file,
  SEARCH/REPLACE, or fenced SEARCH/REPLACE prompts. Each invocation constructs
  fresh history with the configured editor model/capabilities, current approved
  paths, no repository map, and no shell execution; cancellation and provider
  failure leave the parent session reusable.
- One six-value production edit-format schema shared by CLI/YAML/environment
  configuration, model settings, slash-command parsing, and terminal mode
  completion. Helper-only format names are no longer accepted by public model
  contracts and are rejected before provider construction.
- Canonical pinned strategy prompts, examples, reminders, and shell policy for
  all six production formats, with prompt/context/parser fences reselected from
  current files before every initial and reflected provider attempt. Patch
  retains stricter ambiguity rejection, path approval, transactional writes,
  and explicit command approval.
- Production `/attach` media context for approved repository-contained PNG,
  JPEG, WebP, and PDF files. Capability checks precede reads;
  no more than four files, 5 MiB each and 10 MiB total, are retained. Bounded
  cancellable no-follow reads validate extension/signature (and reject encrypted
  PDFs), `/drop` removes attachments, and encoded bytes never enter histories or
  diagnostics. Bundled OpenAI vision capabilities and sparse metadata capability
  merging were corrected so omitted metadata no longer disables configured media.
- Production prompt-cache keepalive behind `--cache-keepalive-pings`,
  `PATCH_CACHE_KEEPALIVE_PINGS`, or `cache-keepalive-pings` YAML. The default is
  zero network requests; opted-in sessions schedule at most ten one-token
  refreshes per schedule, the schedule being replaced and its count restarted on
  each accepted prompt as pinned aider does, 295 seconds apart, send only through
  the last cache marker, ignore background failures, and cancel timers/in-flight
  requests on replacement or shutdown.
- Repeated assistant-prefill continuation for capable models, bounded to three
  follow-up requests. Each request replaces the prior trailing prefill, adds only
  the new suffix, aggregates usage/cost across requests, and preserves final
  stop, provider-error, and cancellation behavior without duplicate history.
- Separately gated live OpenAI and Anthropic contract suites for secret-safe
  credential preflight, minimal streaming, usage, stop reasons,
  timeout/cancellation, OpenAI image input, and Anthropic cache-control input.
  Default CI skips every live request when its explicit gate or credential is
  absent.
- Offline `/help` command listing and bounded literal search over six allowlisted
  installed Patch documents. Results include document/line references, require
  no provider, embedding download, or network, and are exercised through the
  executable installed from the packed tarball.
- Read-only `/settings` output constrained to nine safe effective/current
  values, including post-switch model and mode. Raw configuration, paths,
  commands, identities, environment, provider options, model extras, and
  credentials are omitted rather than partially masked.
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
  dotenv, and command-line values. Packed smoke now verifies the implemented
  YAML → environment → dotenv → CLI order through the actual installed binary.
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
- File-mention detection with an approval hook for new or unselected paths.
- Atomic model/provider/strategy switching with state transfer and removal or
  summarization of history that uses an incompatible edit format.
- CLI one-shot `--message`, `--message-file`, and serial interactive line input.
  Packed smoke now drives the actual installed bin through one-shot and two-turn
  deterministic OpenAI-wire sessions, verifies retained history, and rejects a
  malformed stream without external network or live credentials.
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

- The installed package ships `docs/`, so the policies the README and help point
  at — command behavior, terminal and filesystem safety, URL fetching, turn
  ordering, configuration — are readable from an install rather than only on
  GitHub. Package smoke asserts they survive both packing and installation.
- Packed repository-map extraction covers all eleven shipped languages. Package
  smoke checked five, so a grammar or query that failed to pack — TSX, Bash,
  C/C++, C#, Java, or Ruby — would only have surfaced at runtime.
- Upstream goldens grew from one two-file Python repository map to one tagged
  sample per shipped language, the important-root-file selection, and
  unified-diff parsing for a two-file response. Patch's WebAssembly grammars and
  copied tag queries reproduce aider's tags exactly for each committed sample
  across the eleven shipped language entries.
  The unified-diff golden records one deliberate divergence: upstream strips
  `a/`/`b/` prefixes only from a block's leading header pair, so it targets
  `b/second.py` for a mid-block file transition where Patch targets
  `second.py`.
- The fixture exporter runs on Windows. Aider's repository map holds its SQLite
  tags cache open, which Windows will not let the temporary directory delete, so
  every export failed at cleanup after computing its results.
- Added source blob hashes in `upstream.json` and exporter rejection of dirty
  checkouts and mismatched committed/on-disk hashes for listed sources. The later
  2026-09-11 audit found three imported modules missing from the list; ordinary
  changes still fail the clean-tree check, but independent hash coverage is
  incomplete and remains open.
- `/web <url>` fetches one user-typed URL and adds its readable text to the
  chat, labeled with the URL redirects ended at and truncated to a quarter of the
  model's input window. HTML becomes text through a dependency-free converter
  that keeps headings, lists, and absolute links and drops scripts, styles,
  media, and every other attribute. A URL a model or a fetched page mentions is
  never followed, nothing is loaded as a subresource, and the fetcher — with its
  SSRF, redirect, size, and content-type policy — is constructed only when the
  command first runs.
- Directories and globs select files. `--file`, `--read-only`, `/add`,
  `/read-only`, and `/drop` accept a directory or a `*`/`**`/`?`/`[...]` pattern
  and expand it inside the repository boundary: symbolic links are skipped,
  `.git` is never descended into, ignored files are dropped, an absolute glob is
  refused, and a selection over 200 files or a walk past 20,000 entries fails by
  name. A directory was previously refused outright.
- `/run --interactive <command>` hands the terminal to one approved command
  through the optional `node-pty` package, which is loaded at that point and at
  no other. The line reader is released for the child and restored afterwards
  with its prompt, recall history, and draft. Upstream infers a PTY from the
  environment; Patch requires the flag, never gives a model-suggested command
  the keyboard, and refuses by name in `--web`, `--watch-files`, one-shot, and
  embedded sessions. Child output is still sanitized, so full-screen programs
  are not usable and only line-oriented sessions are.
- Multiline input that works turn after turn: Alt-Enter holds the current line
  and starts another, and Enter submits the whole message. `--multiline`'s
  buffer-until-EOF behavior is unchanged and remains separate.
- Ctrl-X Ctrl-E opens the current draft in `--editor`, `VISUAL`/`EDITOR`, or the
  platform default. The result returns to the prompt rather than being
  submitted, and an editor that fails leaves the draft intact.
- Tab completion is connected to the interactive reader. The completion engine
  existed but nothing called it; commands and the currently selected files now
  complete, re-read per keystroke so they follow `/add` and `/drop`.
- Input recall from earlier sessions, tied to the existing
  `--input-history-file` opt-in: with a history file configured the arrow keys
  reach previously submitted inputs. Damaged lines are skipped rather than
  failing startup.
- Repository-map language support grew from five to eleven: Bash, C/C++, C#,
  Java, and Ruby were added with their upstream tag queries.
- Files no bundled grammar covers now contribute lexical references to the
  ranking graph, so a config file or Markdown document that mentions a symbol
  helps rank the file that defines it. References only, bounded per file, and
  binary files are skipped.
- Files that orient a reader in an unfamiliar repository — READMEs, licenses,
  manifests, lockfiles, CI definitions — are listed in the map before ranked
  symbols, so they survive truncation.
- The repository map is sized from the model's context window rather than a
  fixed 1,024 tokens, and a turn with nothing in the chat gets a wider view of
  the repository, capped so the map cannot crowd out the conversation.
- The tag cache records an extractor fingerprint covering the extractor version,
  every bundled query's text, and each grammar's size. Upgrading a query or
  grammar previously reused tags extracted by the old one.
- The tracked-file inventory is re-read each turn instead of being frozen at
  startup, so a file added, removed, or renamed mid-session reaches file context
  and the repository map without restarting Patch.
- The terminal prints one token and cost line after each turn — sent, cached,
  and received tokens, then the turn and session cost. Usage was already
  collected but had nowhere to go. A model with no known prices reports tokens
  alone rather than implying a cost of zero, and a turn costing under a cent
  keeps four decimals so it is not displayed as `$0.00`.
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

- Took the approval prompt for a captured `/run` outside the worktree lock, as
  interactive `/run` already did. Holding the lock across a question nobody has
  answered yet blocked every other session sharing the worktree for as long as
  the prompt stood. Only the execution holds the lock now.

- Charged history summarization to the session. The summarizer consumed only
  text and error events and discarded usage, so the weak-model call every
  compacting turn pays for was invisible in the reported cost — the
  commit-message path already accounts for its own. It also now sends the weak
  model's temperature policy, as every other request does.

- Sanitized the three terminal status lines that interpolated untrusted text
  directly: the fetched URL, a watch-mode failure, and a failed notification
  command. Only the Commander streams and the executable's own failure path were
  covered, so `docs/terminal.md`'s "only styling Patch itself emits survives" did
  not hold for them.

- Stopped one stray C1 byte from discarding the rest of a model response. The
  terminal sanitizer treated every byte in `0x98`-`0x9F` as a string introducer,
  but `0x9C` is ST, a terminator, and `0x99`/`0x9A` open nothing. Because a
  stream keeps one sanitizer for its lifetime, a single such byte — trivially
  produced by Latin-1 mojibake — swallowed everything after it. Only DCS, SOS,
  OSC, PM, and APC open a string now.

- Supplied the path-approval callback from the terminal, which nothing did. Every
  approval that gates a path the model chose was therefore dead: an edit to an
  unselected file was refused outright, a filename mentioned in prose was ignored,
  and `/attach` could not succeed at all — its approver is required, and there was
  none, so the documented command always failed. Each prompt now states its
  reason. `/add` no longer consults the approver: the user named those paths in
  the command they just typed, and containment and ignore rules still apply.

- Refused an editor edit format the editor role has no prompts for before the
  architect requests a plan, rather than when the editor is constructed — which
  is after the plan has been paid for and accepted. The check stays out of
  startup, since a session that never uses the architect is unaffected.
- Stopped comparing listings of the system temporary directory to prove the
  external editor cleans up. The editor now records the file it was given, so
  another test running an editor at the same moment no longer fails this one.

- Built the URL fetcher once per session instead of once per `/web`, which is
  what the documentation described, and printed the URL being fetched in the
  terminal. The start and completion events existed but nothing rendered them,
  so a slow fetch showed nothing at all.

- Stopped reclaiming an HTTP session that was in use. Only a message post moved
  the idle deadline, so a client holding an event stream, or polling the session
  snapshot, was dropped mid-stream at the TTL. Any request addressed to a session
  now refreshes it, and a session with a connected event stream is not idle.
  Reclamation no longer blocks the request that triggers it either: closing an
  application waits for its queue to drain, which put unrelated requests behind
  an expiring session's in-flight work.

- Counted U+2028 and U+2029 as line-ending characters wherever output claims to
  be control-free. They are separators rather than controls, so they passed the
  `/settings` label filter, the `/report` title check, and the HTTP partial-path
  check, and any consumer that splits on Unicode line breaks would have read a
  forged extra row. The HTTP path check also rejects a drive-relative `C:file`,
  not only `C:/file`, and `renderReport` bounds its title itself now that it is
  exported.
- Reported `Git` in `/settings` as whether Git is in use rather than whether the
  flag was left on, which said "enabled" when running outside a repository.

- Made the suite pass on Windows and stop timing out under load. The worktree
  serialization test compared a created file against an LF-terminated string,
  but a new file takes the platform line ending by documented policy, so it
  asserted the separator rather than the line. Test timeouts are also 30 seconds
  rather than the default five: these tests drive real Git subprocesses and
  loopback servers, and the commit-policy lifecycle test takes about three
  seconds on its own, which left no headroom when the suite ran in parallel.

- Unescaped doubled braces when interpolating the ported strategy prompts. These
  strings come from templates upstream renders with `str.format`, so the
  whole-file example shipped `print(f"Hey {{name}}")` instead of the Python
  upstream shows. Interpolation is now a single left-to-right pass that collapses
  `{{`/`}}` and never rescans a substituted value.

- Serialized `runEditor` on the session queue. It was the only public turn entry
  point that did not take the queue, so a caller invoking it directly ran a
  second turn against the same worktree concurrently with `submit`, mutating
  parent state off-queue. The architect calls the unqueued body, since it holds
  the queue already.

- Approved context-selection paths before disclosing them. Containment, ignore,
  and approval checks ran only on the pass that converged, but each pass sends
  the contents of the files the previous pass named: a file the caller went on to
  deny had already been read and sent to the provider. They now run on every
  pass, once per path. A missing approver is also treated as permission rather
  than refusal, matching `/add`, so an embedding without one can use the feature
  at all.

- Stopped a staged `web-port` or `web-token-file` from failing every terminal
  run. The guard that refuses the pair without `web` was reading the merged
  configuration, so a `web-port:` in `.patch.conf.yml` or `PATCH_WEB_PORT` in the
  environment aborted startup for a run that never wanted HTTP. Only a
  command-line request is refused now. `webPort` is also left unset rather than
  defaulted to zero, so asking for port 0 is no longer indistinguishable from
  asking for nothing.

- Stopped a failed provider close from undoing a `/model` switch that had
  already happened. Retiring the replaced provider ran inside the switch's own
  `try`, so a rejection there took the catch path and closed the newly installed,
  now-active provider, reported the switch as failed, and left the closed
  provider in the owned set to be closed again at session close. Retirement is
  now cleanup after the switch is committed.

- Took every bundled model limit from the row for the transport Patch uses.
  `claude-sonnet-4-6` carried the one-million-token window of the `openrouter/`
  row while addressing Anthropic directly, where the limit is 200k and the wider
  window is a beta this client never requests: a 300k prompt passed local
  budgeting and was refused by the API, and would have been priced without
  Anthropic's long-context tier. The DeepSeek entries were rounded off the same
  table (131072 and 65536, not 128000 and 64000), and `deepseek-reasoner` priced
  cache writes at zero where upstream leaves them unpriced, so a cache miss now
  falls back to the ordinary input price it is really billed at.

- Made `htmlToReadableText` linear, as its documentation already claimed. It
  rescanned all of the text produced so far on every block tag, so `/web` on an
  ordinary large page blocked the session for minutes: 1.4 MB took 136 seconds
  and now takes 26 milliseconds. Separating whitespace is held as counters and
  emitted before the next piece of content instead. Output is unchanged, checked
  against the previous implementation over 20,000 generated documents.

- Anchored unified-diff application to line boundaries. A search side that
  carries a `\ No newline at end of file` marker has no trailing newline, and
  plain substring matching applied it inside a longer line: applying `old` to
  `folder` produced `fnewer`. A match must now start a line, and a marked search
  side must also end the content, since that is what the marker asserts; both
  failures are reported as a no-match instead of corrupting the file. A detached
  marker in a hunk that changes nothing is now rejected as well.

- Ran the packed-binary provider smoke on Windows. The deterministic preload is
  passed to `--import` as a `file://` URL, because Node's ESM loader rejects a
  bare Windows absolute path as an unsupported `c:` scheme, and arguments that
  contain a space are quoted for the `.cmd` shim's shell command line instead of
  splitting into two arguments. `npm run smoke:package` previously failed on
  every `windows-latest` run that reached the provider section.

- Returned a structured, allowlisted HTTP recovery result when a turn fails
  after changing files or creating a commit. The response includes bounded safe
  relative paths, a validated commit ID, and command status metadata, but never
  the underlying error, command text, stdout, or stderr. A concrete web test
  verifies that four edits surviving a configured-check failure match the final
  file, while a boundary test injects secret values into every excluded field.
- Checked exact existing files and directories before interpreting selection
  text as a glob. A literal `[ab].txt` beside `a.txt` and `b.txt` is now selected
  alone at startup and through file commands, while `[ab].md` still expands when
  no exact path exists. Containment, expansion bounds, and downstream literal
  Git pathspecs are unchanged. Ignore filtering still applies to everything an
  expansion sweeps up; a name that matches an existing file is now treated like
  any other explicitly named path, so an ignored one is refused by name rather
  than dropped as an ignored match.
- Parsed standard unified-diff `\ No newline at end of file` markers instead of
  rejecting them. Marker placement now preserves, adds, or removes a final
  newline through the real resolver, detached markers fail as malformed, and
  repeated marker-derived search text remains ambiguous rather than changing
  multiple locations. This intentionally corrects pinned aider's behavior,
  which tolerates the marker but discards its newline meaning.
- Cached and written input tokens are priced separately from ordinary ones. The
  catalog charged the flat input price for every input token, so a turn served
  almost entirely from the provider's cache cost the same as one that was not,
  and Anthropic's cache-write tokens were neither reported nor billed. Models
  now carry cache-read and cache-write prices, a model that prices neither is
  unaffected, and the accounting line names a cache write. Adapters also
  normalize one usage contract — `inputTokens` counts every billed input token —
  because OpenAI includes cached tokens in its prompt count and Anthropic
  reports them alongside one that excludes them.
- Every advertised bundled model carries an input limit, an output limit, and
  catalog prices. Only `deepseek/deepseek-chat` had a metadata entry, so
  `gpt-4o`, `gpt-4o-mini`, `claude-sonnet-4-6`, `claude-haiku-4-5`, and
  `deepseek/deepseek-reasoner` had no input ceiling to budget against, sized
  their repository map from the 1024-token fallback, and reported an unknown
  cost for every turn. An oversized prompt was sent to the provider rather than
  refused. The values come from the LiteLLM table the pinned aider revision
  resolves them from, and a catalog entry added without them now fails a test.
- `.aiderignore` composes with ordinary Git exclusions instead of replacing
  them. Patch supplied the file as `core.excludesFile`, so a project that had an
  `.aiderignore` lost the user's global ignore policy for Patch's own check, and
  a file excluded everywhere else became eligible for selection, mention
  matching, repository maps, and provider messages. The check now runs under the
  repository's ordinary rules as well, and a path either policy matches stays
  out, as upstream does by keeping the two checks separate.
- The ancestor-swap fault injection reaches its identity check on Windows. The
  swap ran while the temporary file's handle was still open, and Windows refuses
  to rename a directory that contains an open file, so the injection failed with
  `EPERM` instead of exercising the detection it exists to prove. It now swaps
  once the handle is closed, which is still inside the window the adapter
  rechecks; production containment is unchanged.
- The permission-retention test asserts retention instead of a hard-coded
  `0600`, so it holds on Windows. Windows `chmod` only toggles the read-only
  bit, so the fixture's mode stayed `0666` and a correct replacement failed the
  assertion; the mode the file actually carried is now the expectation, and the
  POSIX case still pins `0600` explicitly.
- Path-resolution tests compare against canonical fixture roots, so the
  `platform` CI job no longer fails on macOS and Windows. `SafePathResolver`
  canonicalizes its root, but the temporary-directory helper returned whatever
  `mkdtemp` produced: `/var/folders/...` on macOS, which is a link to
  `/private/var/...`, and an 8.3 short name such as `C:\Users\RUNNER~1\...` on
  hosts whose account name exceeds eight characters. The resolver was right and
  the expectation was not.
- Subprocess output and status are visible. `/run` reported only one stream and
  no exit status, so a command that wrote to stderr, was denied, or timed out
  looked like one that said nothing; it now reports the command, how it ended,
  both streams, and truncation. Every model-suggested command reports the same
  way through a `command-complete` event as it finishes, and configured lint and
  test commands report through their `*-complete` events, so approving or
  configuring a command and then seeing nothing no longer resembles a hang.
- Shell completion is generated from the options the parser registered. The
  inventory was a hand-kept list that had fallen behind, so `patch
  --shell-completions` omitted `--model`, `--web`, `--watch-files`, and every
  other option added since it was written; a test now holds the two level.
- `--notifications` fires for a provider turn and not for a slash command, which
  answers immediately, and a notification command that fails is reported instead
  of ending the input loop.
- Ctrl-C abandons the line being typed and every line Alt-Enter is holding.
  Node's reader emits `SIGINT` without touching the buffer, so an abandoned line
  reappeared in front of whatever was typed next.
- `--vim` is refused with its reason instead of being accepted and ignored.
  Node's line reader has no modal editing, so the flag promised bindings that
  were simply absent; it now fails startup, names Ctrl-X Ctrl-E as the editor
  path Patch does offer, and is no longer listed in shell completions.
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

- The documented slash-command inventory is now asserted equal to the parser's
  source of truth, and a real-Git application scenario executes every one of the
  19 advertised effects. Safe failures cover missing clipboard/undo state,
  contained paths, unknown models, refused URL ingestion, denied processes, and
  use after exit; no unsupported advertised command was found.
- Joint executable acceptance for `/help`, `/settings`, and `/report` now covers
  serialized queue order, active and queued cancellation, hostile terminal
  metadata, unchanged write/path/process approvals, and dispatch from the actual
  binary installed from a packed tarball.
- Provider failures now expose fixed safe diagnostics instead of SDK/server
  messages. OpenAI and Anthropic propagate only a parsed `Retry-After` delay;
  seconds, dates, and `retry-after-ms` are accepted, malformed values are ignored,
  and both provider and session caps prevent delays above 60 seconds. The session
  keeps its three-attempt default, rejects unbounded retry configuration, and
  aborts during backoff without another request.
- Gave `diff-fenced` its distinct pinned filename-inside-fence protocol instead
  of sending the same prompt and example as ordinary `diff`. Strategy examples
  and the fenced reminder now interpolate the fence selected from file content,
  and a concrete fake-provider test compares both outbound requests under a
  forced quadruple-backtick fence. The shared parser and shell-command policy
  are unchanged; full canonical format-specific prompt parity remains open.
- Production commits now honor CLI/YAML/environment hook verification and
  explicit author/committer/co-author settings. Optional weak-model subject
  generation sends only selected diffs, enforces input/output/cancellation
  bounds, retains usage, and stops before staging on failure. Checkpoints,
  model edits, configured checks, and `/commit` share the policy; explicit
  manual messages bypass generation. Existing defaults remain unchanged.
  Real-Git executable-program tests and installed-service smoke tests cover
  the policy; broader Aider default/option parity is not claimed.
- Closed the audited fixture-source hash gap with pinned hashes for all twelve
  direct driver imports. Node tests now check actual explicit imports rather
  than a fixed list and exercise exporter rejection of `assume-unchanged` and
  `skip-worktree` modifications. This adds no runtime Python dependency and
  does not claim transitive dependency or resource-file hash coverage.
- Continuous integration checks out and installs Node.js through
  `actions/checkout@v5` and `actions/setup-node@v5`. The `v4` actions target
  Node.js 20, which GitHub has deprecated and already forces onto Node.js 24, so
  every run carried a deprecation annotation. Job inputs and behavior are
  unchanged.
- Reconciled live documentation with the 2026-09-11 parity audit while preserving
  the dated report as evidence. Corrected metadata, inventory, worktree-lock,
  watch-error, DeepSeek-prefill, history, and HTTP recovery claims; reopened
  incomplete fixture-source hash coverage without claiming an implementation fix.
  Fenced-diff prompt parity and executable source-identifier completion are now
  explicitly unchecked rather than inferred from constructed helpers.
  Merged input modes into the terminal guide and model-command execution into
  the command guide, removed the superseded historical composition plan, and
  linked the latest audit from contributor guidance, the README, and the backlog.
  No runtime behavior changed.

- Closed the P2 ancillary feature scope decision without adding runtime behavior:
  select local `/help`, secret-safe `/settings`, and a reviewable local `/report`
  draft for implementation; defer browser GUI and voice UX; make analytics,
  automatic onboarding/OAuth, and built-in update/release-note flows non-goals.
  The plan records the rationale and pinned upstream differences, and the
  backlog retains unchecked executable acceptance work for the three commands.

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
