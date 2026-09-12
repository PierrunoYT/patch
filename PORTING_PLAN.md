# Aider-to-Patch TypeScript Porting Plan

## Source baseline

Patch will port behavior from the canonical
[`Aider-AI/aider`](https://github.com/Aider-AI/aider) repository at commit
[`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c).
The reference checkout is the sibling directory `../aider-upstream` — on this
workstation `D:\Github\aider-upstream`, next to `D:\Github\patch`. Set
`AIDER_CHECKOUT` to use another location; `scripts/export-upstream-fixtures.mjs`
resolves that variable first and otherwise falls back to the sibling directory,
and it rejects any checkout whose remote or commit differs from `upstream.json`.
The checkout must remain outside this repository and must not become a
submodule.

At this baseline, aider contains approximately 20,285 lines in 80 Python
modules and 36 test modules. Patch began as a greenfield TypeScript port and now
contains tested configuration, provider, edit, Git, repository-map, application,
and adapter components. The installed CLI composes the supported core workflow;
the unchecked phase items below identify behavior that remains helper-only,
partially integrated, or unsupported.

The upstream source is Apache-2.0 licensed. Every directly ported file must:

- preserve the required license and attribution;
- identify the upstream path and pinned source commit;
- state that the TypeScript version was modified for Patch; and
- retain behavior-focused tests derived from upstream without claiming that
  Patch is an official aider release.

## Goal

Build an npm-installable Node.js 22+ terminal application that preserves
aider's essential workflow:

1. resolve configuration and a model;
2. select editable and read-only files;
3. send repository context to the model;
4. parse a supported edit format;
5. preview and authorize writes;
6. apply edits safely;
7. commit, lint, test, and reflect on failures; and
8. continue as a multi-turn terminal session.

The first release will not claim complete aider compatibility. Provider,
edit-format, option, and interface support must be documented explicitly.

Current implementation priorities live in
[the integration backlog](docs/remaining-integration-tasks.md). The latest
[dated audit](docs/aider-parity-audit-2026-09-11.md) compares Patch
`476d1657410bdd47982cc7fddb179ccf83d4a734` with the pinned aider revision above;
it supplements the historical audit of Patch
`58597efc390e8e138b29024871a25d192fb27462`. Dated reports preserve their original
evidence; this plan and the backlog track current status and open work.

## Scope decisions

### MVP

- Node.js 22+, TypeScript, ESM, and npm.
- One package and one executable. Do not introduce a monorepo until separate
  packages have independent consumers.
- OpenAI-compatible models first; Anthropic second.
- `ask`, whole-file, and SEARCH/REPLACE edit formats.
- One-shot and line-oriented interactive terminal modes.
- Editable and read-only files with explicit authorization for new or
  out-of-chat files.
- Git discovery, tracked/ignored/dirty state, diff, checkpoint commits,
  auto-commit, and undo.
- Config file, environment, and CLI precedence.
- Configured lint and test commands plus explicitly approved shell commands.
- Streaming, cancellation, retries, token limits, and conversation history.

### Current staged parity

- Repository maps are production-wired for JavaScript, TypeScript/TSX, Python,
  Go, Rust, Bash, C/C++, C#, Java, and Ruby, sized to the model's context
  window, and files no grammar covers contribute lexical references. Every
  shipped language entry has one sample whose tags match upstream's own
  extractor exactly; context mode and broader ranking/personalization fixtures
  remain. Models without input limits use the default map budget.
- Unified-diff file transitions and standard no-newline markers, plus Patch
  scopes/repeated actions, are constructed and tested locally. Broader
  unified-diff recovery, remaining format-specific prompts, and broader pinned
  goldens remain incomplete.
  Architect/editor, context, help, and other advanced formats are unconstructed.
- Terminal Markdown, diff previews, explicit history writes, notifications, and
  text clipboard adapters exist. Completion, opted-in recall, turn-after-turn
  multiline, the external editor, and explicitly requested PTY dispatch are
  connected to the reader, shell completion is generated from the parser's own
  options, and notifications fire for provider turns only; Vi modal editing is
  refused rather than implemented, and renderer fidelity stays out of scope.
- File selection checks an exact contained file or directory before interpreting
  glob metacharacters, then applies the same bounded contained expansion and
  ignore filtering to actual patterns.
- OpenAI and Anthropic have basic executable routes, DeepSeek requests are
  normalized for its endpoint, and post-finish usage events are retained.
  Metadata merging, temperature policy, bounded retries, and weak-model history
  compaction are wired. Bundled limits/prices and cache accounting are incomplete;
  editor, media, and cache-keepalive workflows remain unintegrated.
- Watch and a local authenticated HTTP/SSE API start through the application and
  share one worktree mutation lock, and `/web` ingests one user-typed URL as
  bounded, labeled text. GUI and CLI voice UX are deferred. HTTP disconnect
  cancellation is wired but needs targeted runtime evidence; partial-turn errors
  expose only bounded recovery metadata. Expiry, quotas, backpressure, and
  reclamation remain open.
- The eight ancillary feature families have explicit dispositions below.
  Offline `/help` and allowlisted `/settings` are implemented. `/report` is
  selected for implementation but remains absent; deciding its scope does not
  establish executable parity.

### Ancillary feature dispositions — P2 item 7

Decision recorded 2026-09-11 against Patch `47ba7f565` and aider
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`. This supplements, rather than
replaces, the audit of Patch `58597efc390e8e138b29024871a25d192fb27462` in
`docs/remaining-integration-tasks.md`. Upstream paths below refer to that pinned
checkout. *Implement* means committed scope with acceptance work still open;
*deferred* means wanted but not scheduled; *non-goal* means intentionally absent.
No runtime behavior changes with this decision.

| Family | Disposition | Scope, rationale, and intentional difference |
| --- | --- | --- |
| `/help` | Implemented | Lists supported commands and searches six bundled Patch docs locally, returning at most eight bounded line excerpts with source references. It is verified through parser/application tests and the executable installed from a packed tarball. No provider call, embedding download, or network access occurs. This supports offline discovery without the cost and dependencies of aider's model-backed help (`aider/help.py`, `aider/commands.py:1119`). It does not construct aider's help coder. |
| `/settings` | Implemented | Shows nine explicitly allowlisted, read-only values: bounded current model/mode labels, encoding, Git/hook/generated-message states, lint/test configured states, and whether bootstrap corrected the root. Post-switch and packed-executable tests prove current state is shown. Raw arguments, paths, commands, identities, environment, provider headers/endpoints, model extras, and credentials never enter the renderer; tests require full secrets and suffixes to be absent from terminal output, histories, and provider requests. This keeps configuration diagnosable without reproducing `aider/format_settings.py`'s broad dump and partial key masking (`aider/commands.py:1432`). |
| `/report` | Implement | Generate a bounded local issue draft with allowlisted Patch/Node/OS/Git versions and user-supplied title. Exclude chat, source, paths, environment, credentials, and raw diagnostics. Show the draft for review; no upload, automatic browser launch, or diagnostic-filled URL. Users can copy it into the issue tracker themselves. This trades one extra step for control over disclosure compared with `aider/report.py` and `aider/commands.py:1555`. |
| Browser GUI | Deferred | A GUI remains wanted but unscheduled: the terminal is the primary product, and a second UI has substantial maintenance cost. The authenticated local HTTP/SSE API is not a GUI. Revisit only after its session lifetime, quotas, backpressure, and approval UX are addressed; keep the shared application contracts instead of porting Streamlit (`aider/gui.py`). |
| Voice UX | Deferred | Keep the optional library helper, not a production CLI voice claim. A later UX must make microphone capture and transcription-provider disclosure explicit, support cancellation, and allow transcript review before submission. Cross-platform devices, optional audio tools, and audio privacy justify deferral (`aider/voice.py`, `aider/commands.py:1252`, `aider/io.py`). |
| Analytics | Non-goal | No built-in usage telemetry, analytics identity, or analytics service integration. The privacy and permanent operational cost outweigh product metrics for this terminal tool. Local token/cost accounting is unaffected; it is not analytics collection (`aider/analytics.py`). |
| Onboarding/OAuth | Non-goal | No automatic provider/model selection, account-tier probes, or browser OAuth/credential-persistence flow. Keep explicit model and credential configuration, supported by setup documentation and actionable validation errors. This avoids provider coupling and implicit network/credential side effects (`aider/onboarding.py`). |
| Update/release notes | Non-goal | No built-in version probes, self-update, or automatic release-note prompts/browser launch. Updates remain user-managed through npm and release notes remain in the changelog. Upstream throttles ordinary version probes for 24 hours, but even periodic startup networking is unnecessary here (`aider/versioncheck.py`, `aider/main.py`). |

The unchecked command acceptance tasks in
[the integration backlog](docs/remaining-integration-tasks.md#ancillary-command-implementation-follow-ups)
must be verified through the installed executable before these commands can be
advertised as available. Deferred and non-goal families do not block those tasks
and do not waive existing API safety work or unrelated release blockers.

### Non-goals

- Translating Python syntax module by module without first defining TypeScript
  contracts.
- Reproducing Python implementation accidents such as mutable class state.
- Depending on Python or spawning aider at runtime.
- Claiming all LiteLLM providers work through a partial compatibility shim.
- Placing parser grammars or runtime resources in `assets/`; that directory is
  reserved for `logo.svg` and `logo-icon.svg`.

## Upstream architecture

```text
CLI/config ──▶ model registry/provider ──▶ Coder conversation loop
    │                    │                         │
    │                    │                         ├──▶ edit strategy
    │                    │                         ├──▶ Git repository
    │                    │                         ├──▶ repo map
    │                    │                         └──▶ lint/test/shell
    │                    │
    └────────────▶ terminal/browser adapters ◀────┘
```

The main behavior owners at the pinned revision are:

| Concern | Upstream source | Important behavior |
| --- | --- | --- |
| Executable | [`pyproject.toml`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/pyproject.toml#L26-L27), [`aider/__main__.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/__main__.py#L1-L4) | Both entry points call `aider.main:main`. |
| Startup/config | [`aider/main.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L451-L504) | Provisional Git root, preliminary parse, dotenv loading, then final parse. |
| CLI options | [`aider/args.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/args.py#L35-L169) | Config files, `AIDER_*` environment values, model settings, and dynamic edit formats. |
| Session construction | [`aider/main.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L903-L1007) | Wires repository, commands, summarizer, and coder. |
| Mode dispatch | [`aider/main.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L1053-L1180) | One-shot operations, messages, interactive loop, and coder switching. |
| Core session | [`aider/coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L88-L201) | Coder registry/factory and state transfer between modes. |
| Conversation loop | [`aider/coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L859-L944) | Input preprocessing and bounded reflection loop. |
| Provider turn | [`aider/coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1419-L1623) | Streaming, retry, truncation, edit, commit, lint, shell, and test sequence. |
| Prompt chunks | [`aider/coders/chat_chunks.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/chat_chunks.py#L5-L64) | Stable message ordering and provider cache boundaries. |
| Edit authorization | [`aider/coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2175-L2336) | Authorize files, checkpoint dirty files, dry-run, apply, and reflect on malformed output. |
| Registered modes | [`aider/coders/__init__.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/__init__.py#L1-L34) | Explicit list of coder implementations. |
| Whole-file edits | [`aider/coders/wholefile_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/wholefile_coder.py#L10-L128) | Fenced block parsing and filename inference. |
| SEARCH/REPLACE | [`aider/coders/editblock_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_coder.py#L15-L217) | Exact, indentation-aware, and elided replacement matching. |
| Unified diff | [`aider/coders/udiff_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/udiff_coder.py#L46-L118) | Unique-context hunk application and diagnostics. |
| Patch format | [`aider/coders/patch_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/patch_coder.py#L13-L93) | Typed add/delete/update/move actions and fuzzy context. |
| Model behavior | [`aider/models.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/models.py#L127-L150) | Capabilities, formats, weak/editor models, caching, and request options. |
| Model resolution | [`aider/models.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/models.py#L329-L645) | Alias, metadata, exact setting, heuristic setting, and secondary-model resolution. |
| Provider bridge | [`aider/llm.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/llm.py#L9-L45), [`aider/sendchat.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/sendchat.py#L5-L61) | LiteLLM loading plus provider-message role repair. |
| Git | [`aider/repo.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L52-L126) | Repository discovery and common-root validation. |
| Git changes | [`aider/repo.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L201-L417) | Commit attribution, commit messages, staged/unstaged diffs. |
| Tracked/ignored files | [`aider/repo.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L433-L602) | Tracked files, `.aiderignore`, and dirty state. |
| Repository map | [`aider/repomap.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L266-L574) | Tree-sitter tags, reference graph, and PageRank. |
| Map fitting/rendering | [`aider/repomap.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L629-L784) | Token-budget search and source-context rendering. |
| Terminal I/O | [`aider/io.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L230-L507) | Prompts, history, confirmations, encoding, newlines, and writes. |
| Input UX | [`aider/io.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L523-L692) | Completion, multiline editing, and interruption. |
| Commands | [`aider/commands.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L30-L203) | Command discovery, dispatch, and mode changes. |
| Linting | [`aider/linter.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/linter.py#L21-L269) | Configured and language-specific diagnostics. |
| Commands/processes | [`aider/run_cmd.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/run_cmd.py#L11-L132) | Captured and PTY command execution. |
| Watch mode | [`aider/watch.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/watch.py#L15-L255) | Ignore rules, `AI!`/`AI?` markers, and input interruption. |
| Browser UI | [`aider/gui.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/gui.py#L17-L147) | Streamlit adapter around a shared coder session. |
| Test suites | [`pytest.ini`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/pytest.ini#L1-L12) | Basic, help, browser, and scrape suites with analytics disabled. |

## Target design

Use ports and adapters around one session orchestrator. Do not reproduce the
large inheritance hierarchy around `Coder`; edit formats vary in parsing and
application, not in ownership of the complete session lifecycle.

```text
src/
  config/              config discovery, merge, validation
  core/                application service, session state, messages, prompts
  edits/               whole-file, search/replace, later patch/udiff
  models/              model registry, capabilities, token/cost metadata
  providers/           OpenAI-compatible, Anthropic, fake provider
  repository/          Git CLI adapter, ignore rules, safe paths
  context/             file context and later repository maps
  commands/            typed slash-command registry
  io/                  filesystem and terminal adapters
  process/             lint, test, shell, and PTY adapters
  interfaces/          bounded URL, watch, web, and voice adapters
  resources/           prompts and repository-map runtime resources
  index.ts              public library exports
  cli.ts                npm executable
tests/
  unit/
  integration/
  compatibility/
  fixtures/
```

Runtime resources belong under `src/resources/` and in the npm package `files`
list. A `prepack` script rebuilds `dist/` from a clean directory, so `npm pack`
and `npm publish` cannot ship a stale or partial build, and the package smoke
test asserts the tarball carries both entry points and every copied resource.
`assets/` remains branding-only.

### Core contracts

Define these before implementing adapters:

```ts
interface ModelProvider {
  stream(request: CompletionRequest, signal?: AbortSignal):
    AsyncIterable<CompletionEvent>;
}

interface EditStrategy {
  readonly format: EditFormat;
  parse(response: string, context: EditStrategyContext): EditBatch;
}

interface Repository {
  readonly root: string;
  trackedFiles(): Promise<string[]>;
  isIgnored(path: string): Promise<boolean>;
  isDirty(path?: string): Promise<boolean>;
  diff(paths?: string[]): Promise<string>;
  commit(request: CommitRequest): Promise<CommitResult | undefined>;
}

interface ApplicationService {
  createSession(context: {
    principal: string;
    sessionId: string;
  }): Promise<ApplicationSession> | ApplicationSession;
  close?(): Promise<void> | void;
}

interface ApplicationSession {
  snapshot(): unknown | Promise<unknown>;
  submit(message: string, options: ApplicationSubmitOptions): Promise<unknown>;
  close?(): Promise<void> | void;
}
```

`CommandEffect` is the validated discriminated union in
`src/commands/effects.ts`; it includes path, model/mode, process, Git,
clipboard, submit, and exit effects. Parsing is inert. The concrete application
session owns dispatch and serializes commands and provider turns through one
queue.

All session state must be initialized per instance. In particular, do not copy
the class-level mutable fields in
[`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L88-L123).

The turn state machine should be explicit and serial:

```text
waiting for input
  → parse and dispatch a command, or detect file mentions
  → compose messages and check context budget
  → stream provider response with cancellation/retry
  → parse proposed edits
  → preview and authorize paths
  → checkpoint pre-existing dirty files
  → apply edits
  → auto-commit
  → run configured lint, commit check changes, reflect on failure
  → approve/run suggested shell commands
  → run configured tests, reflect on failure
  → waiting for input
```

Use `AbortController` for cancellation and one async queue for session mutation.
Provider adapters should emit normalized events for text, reasoning, tool-call
fragments, usage, finish reasons, and errors. Preserve raw provider metadata on
events so future adapters do not require changes to the session core.

## Technical choices

Prefer the smallest dependency that preserves behavior. Confirm each package
before adding it; the table records candidates, not pre-approved dependencies.

| Need | Preferred approach | Notes |
| --- | --- | --- |
| CLI | `commander` | Explicit options, negated booleans, and generated help. Test precedence separately. |
| Validation | `zod` | Validate external config and metadata at boundaries. |
| YAML/dotenv | `yaml`, `dotenv` | Preserve aider's staged parse and override order. |
| Providers | official `openai` and `@anthropic-ai/sdk` clients | Start narrow instead of emulating LiteLLM breadth. |
| Retries | small local policy or `p-retry` | Retry only classified transient failures and honor cancellation. |
| Git | installed `git` through `execa`/`child_process` | Git CLI is authoritative for worktrees, index, hooks, ignores, and diffs. |
| Ignore rules | Git CLI `check-ignore` with NUL-delimited standard input | Git evaluates repository and `.aiderignore` patterns without shell expansion. |
| Terminal | `readline/promises`, `picocolors` | Add a rich TUI only after core behavior stabilizes. |
| Processes | `execa`; later `node-pty` | Never put untrusted filenames into shell strings when argv is possible. |
| Diff display | `diff` | Edit protocols need dedicated parsers; do not delegate model output to system `patch`. |
| Tests | `vitest`, `fast-check` | Unit, real-Git integration, and parser property tests. |
| Repo map | `web-tree-sitter`; small PageRank implementation | Defer; avoid native packaging initially. |
| Cache | mtime-keyed files first | Avoid `better-sqlite3` packaging until persistent-cache demands justify it. |
| Browser later | Fastify, SSE/WebSocket, Playwright | Do not port Streamlit mechanics. |

Resolve packaged resources with `import.meta.url`, never `process.cwd()`. Build
ESM, emit declarations and source maps, expose a `bin` entry, and verify the
packed tarball from a clean temporary project.

## Implementation tasks

### Phase 0 — Project and compatibility foundation

- [x] Add `package.json`, lockfile, strict `tsconfig.json`, linting, formatting,
  Vitest, and Node.js 22 engine requirements.
- [x] Add the Apache-2.0 `LICENSE`, upstream attribution in `NOTICE`, and a
  standard header/template for directly ported files.
- [x] Record the pinned upstream commit in a machine-readable file.
- [x] Record every identified direct Aider source/resource derivation in a
  machine-readable ledger and check per-file path, revision, modification, and
  Apache evidence for drift; keep generated fixture provenance separate.
- [x] Add CI for typecheck, lint, tests, build, and `npm pack` smoke testing.
- [x] Build an upstream fixture exporter outside the shipped package. Capture
  normalized outputs from pinned aider for config precedence, prompt chunks,
  edit parsing/application, Git state, and repository maps.
- [x] Define schemas for messages, provider events, edits, repository results,
  command effects, model settings, and session state.
- [x] Add a deterministic fake provider that can stream text, reasoning,
  fragmented tool calls, usage, retryable errors, truncation, and cancellation.
- [x] Enforce LF line endings in Git checkouts so the Prettier gate behaves the
  same on Windows, macOS, and Linux, including when `core.autocrlf=true`.
- [x] Scope Vitest to source tests and clean `dist/` before builds so stale
  generated files cannot execute during validation or leak into packed output.
- [x] Make compatibility tests honor native relative-path separators and the
  documented platform-default newline policy for newly created files.
- [x] Give the real-Git bounded-reflection integration test enough time for four
  complete Windows process/Git cycles without weakening production bounds.

**Exit:** `npm ci`, typecheck, tests, build, pack, clean-install, and `patch
--help` work without Python. The repository-level line-ending policy keeps the
formatting gate portable across Git hosts.

**Local evidence (2026-09-10):** on Windows with Node.js `v24.18.0` and
`core.autocrlf=true`, `npm ci` and `npm run check` pass. The check ran 337 source
tests (333 passed, four explicitly skipped), rebuilt from an empty `dist/`,
packed and clean-installed the tarball, exercised the installed lifecycle, and
invoked the installed `patch --help` entry point without Python.

### Phase 1 — Files, configuration, and messages

- [x] Implement safe path resolution that rejects writes outside the selected
  root after symlink resolution.
- [x] Implement encoding, LF/CRLF preservation, dry-run writes, and atomic file
  replacement.
- [x] Reject hardlinked/non-regular mutation targets and recheck target identity
  immediately before replacement or deletion. Portable ancestor-race and full
  metadata preservation remain open.
- [ ] Complete production prompt resources and per-attempt fence selection.
  The shared resource and selector helpers exist, but constructed strategy
  prompts are abridged and context fencing is inconsistent.
- [x] Implement chat roles and the upstream chunk order: system, examples,
  read-only files, repository map, old history, editable files, current turn,
  reminder.
- [x] Implement provisional Git-root discovery, config search, preliminary CLI
  parse, dotenv loading, final parse, and true-root correction.
- [x] Specify and test precedence among defaults, home config, repository
  config, working-directory config, `.env`, environment, and CLI.
- [x] Load and validate model aliases, model settings, and JSON5 metadata from
  packaged resources.

**Exit (partial):** local fixtures cover selected configuration and generic
chunk/resource behavior. Full production prompt composition, broad pinned
configuration comparison, portable ancestor-race handling, and full metadata
preservation remain open.

### Phase 2 — Edit engines

- [x] Port `ask` as a no-write strategy.
- [x] Port whole-file fenced blocks, including filename inference and trailing
  newline behavior.
- [x] Port SEARCH/REPLACE parsing, shell block separation, exact replacement,
  leading-whitespace normalization, `...` elision, ambiguity detection, and
  failure diagnostics.
- [x] Add a dry-run resolution pass before authorization or writes.
- [x] Represent create, update, and delete operations explicitly.
- [x] Add transactional staging of proposed file contents so parser or
  validation failures cannot leave a partial multi-file update. Document this
  intentional safety improvement if it differs from upstream.
- [x] Property-test malformed fences, repeated text, empty files, Unicode,
  CRLF, duplicate filenames, traversal attempts, and asymmetric replacements.

**Exit:** every selected upstream edit fixture produces the same file contents
or a documented, safer rejection.

### Phase 3 — Conversation engine

- [x] Implement `CoderSession` using an injected `EditStrategy` rather than a
  subclass per complete session.
- [x] Implement per-turn initialization, prompt composition, token-budget
  checks, response assembly, and history transitions.
- [x] Implement streaming events, exponential backoff for classified transient
  failures, `AbortSignal` cancellation, context overflow, and truncation.
- [x] Implement bounded reflection for lint and test failures. Configured
  post-write checks, malformed edits, and resolution failures share three
  reflections, with refreshed disk context and token budgets. Patch currently
  reflects automatically rather than asking aider's per-failure confirmation.
- [x] Implement file-mention detection and explicit approval before adding or
  editing unselected files.
- [x] Complete strategy/model switching with state transfer. `/model` and
  `/chat-mode` rebuild the model, provider, parser, prompts, shell policy,
  fence, and repository-map policy as one profile installed only after
  `CoderSession.switch` accepts the change, and transfer history the
  replacement model can accept. Completed history that outgrows the model's
  budget is summarized automatically with the weak model before the next turn.
- [x] Add one-shot `--message`, `--message-file`, and interactive line input.

**Exit (partial):** installed-service acceptance covers streamed malformed and
unresolvable responses, two-file writes, lint reflection, approved commands,
tests, and undo with exact Git assertions. An interrupted turn whose writes or
commits survive now reconciles its history and reports a structured partial
outcome. Exhaustive failure/cancellation coverage and remaining approval
policies remain in R2/R3 of `docs/remaining-integration-tasks.md`.

**Evidence:** `tests/coder-session.test.ts`, `tests/application-service.test.ts`,
`tests/application-prompt-context.test.ts`, `tests/application-lifecycle.test.ts`,
and packed `scripts/lifecycle-smoke.mjs`.
See `docs/turn-lifecycle.md` for ordering and explicit recovery limits.

### Phase 4 — Real model providers

- [ ] Complete OpenAI-compatible streaming parity. Streaming, custom
  constructor options, post-finish usage, DeepSeek normalization, metadata
  merging, temperature policy, and bounded transient retries are wired.
  Repeated continuation and broader provider-wire evidence remain incomplete.
- [x] Implement Anthropic streaming and system/cache-control differences.
- [x] Implement main, weak, and editor model selection without recursive
  construction bugs.
- [x] Add provider-specific credential diagnostics and supported-capability
  checks.
- [x] Add model-aware token counting where reliable and conservative estimates
  elsewhere.
- [ ] Complete executable usage and cost coverage. Post-finish usage is retained,
  metadata merges into settings, and turn/session reports reach the terminal.
  Most bundled models lack input limits/prices, cache-specific costs are not
  modeled, and wider provider evidence remains incomplete.
- [x] Publish a provider compatibility table; reject unsupported providers
  explicitly.

**Exit (workflow present; live evidence pending):** opt-in provider tests and a
protected manual workflow exist. Ordinary CI is deterministic and requires no
network. Authentication, minimal streaming, and usage are covered when each
credential is supplied; combined live timeout/cancellation and capability
evidence remains incomplete.

**Evidence:** mocked `tests/openai-provider.test.ts` and
`tests/anthropic-provider.test.ts`; opt-in `tests/live-provider.test.ts` via
`.github/workflows/live-providers.yml`.

### Phase 5 — Git, authorization, and commands (MVP)

- [x] Discover one common Git worktree for selected paths and reject paths from
  multiple repositories.
- [x] Make repository-relative Git path arguments literal across diff, stage,
  commit, ignore, and undo operations.
- [x] Filter selected and tracked paths through Git and `.aiderignore` rules
  before snapshots, mention matching, repository maps, or provider requests.
- [x] Refresh the tracked repository inventory per turn after service startup.
  A status failure falls back to the startup inventory, filtered through current
  ignore rules. Evidence: `tests/application-prompt-context.test.ts`.
- [x] Implement the write boundary: preview, deny new/out-of-chat paths unless
  a standalone TTY user or embedding caller authorizes them, checkpoint dirty files, apply, and
  report changed files.
- [x] Wire the selected production commit policy: configurable hook verification,
  explicit author/committer/co-author values, and opt-in bounded weak-model
  commit subjects through CLI/YAML/environment. Checkpoints, model edits,
  configured checks, and manual commits share the policy, with user-authored
  commits excluded from model-author attribution. Full Aider option/default
  parity is not claimed; see `docs/git-repository.md` for deliberate differences.
  Evidence: `tests/application-lifecycle.test.ts`, `tests/config-bootstrap.test.ts`,
  and installed `scripts/lifecycle-smoke.mjs`. Undo remains session-owned and
  refuses root, merge, moved-HEAD, and already-pushed commits.
- [x] Never mutate global `process.env` for commit identity; pass environment to
  that Git child process.
- [x] Implement typed commands for `/add`, `/drop`, `/read-only`, `/ls`,
  `/clear`, `/model`, `/chat-mode`, `/run`, `/test`, `/lint`, `/commit`,
  `/undo`, and `/exit`.
- [x] Require approval for each model-suggested shell command, show the exact
  command, run at repository root, cap output, and support timeout/cancellation
  in the application contract. Standalone interactive TTY input supplies one
  shared approver for writes, model commands, and `/run`; other interfaces deny
  without injected approval. See README for exact input-mode restrictions. Every
  finished command reports its outcome and both streams, so a denied, failed, or
  stderr-only command is never mistaken for silence.
- [x] Run only user-configured lint/test commands; do not guess package-manager
  commands in an arbitrary target repository.

**Exit — partial usable workflow:** the npm-installed binary composes supported
providers and edit formats, previews selected-file edits, commits, runs
configured lint/tests, and dispatches Git commands. A full release exit still
requires per-failure reflection choice and exhaustive failure/cancellation state tests.
The packed service acceptance scenario now passes with injected provider and
approval adapters. `tests/terminal-approval.test.ts` exercises the executable's
program path with real readline input, fake TTY streams, the concrete service,
fake provider, and real filesystem/process effects; native terminal platform
coverage for this approval path is not yet established.

**Evidence:** `tests/application-lifecycle.test.ts`,
`tests/application-commands.test.ts`, `tests/write-boundary.test.ts`, and the
real-repository `tests/git-*.test.ts` suites.

### Phase 6 — Repository maps

- [x] Port definitions/references extraction with `web-tree-sitter`.
- [x] Initially support JavaScript, TypeScript, Python, Go, and Rust. Bash,
  C/C++, C#, Java, and Ruby were added with their upstream queries.
- [x] Keep query files and WASM grammars under `src/resources/repomap/` or use
  version-pinned npm grammar packages; never place them in `assets/`.
- [x] Build the weighted reference graph and deterministic personalized
  PageRank.
- [ ] Complete generic TreeContext-equivalent rendering and model-aware token
  fitting. Current normalized evidence covers one small Python scenario.
- [x] Add mtime/content-keyed cache files, corruption recovery, and `manual`,
  `always`, `files`, and `auto` refresh behavior.
- [ ] Broaden independent map fixtures beyond one two-file Python example,
  including personalization, fallback references, important files, TSX packed
  extraction, and every added language. Tags for all eleven shipped languages,
  TSX included, and important-root-file selection are now pinned against
  upstream's own extractor in `tests/upstream-fixtures.test.ts`, and packed
  extraction for the same set runs from the installed tarball. Personalization
  and lexical fallback references are still unpinned.

**Exit (configured evidence):** representative multi-language fixtures and
packed-resource tests are in the Linux/macOS/Windows CI matrix. Cross-platform
evidence is not claimed until that matrix completes on the pushed revision.

**Evidence:** `tests/repo-map-compatibility.test.ts`,
`tests/repository-map-cache.test.ts`, `scripts/package-smoke.mjs`, and the
`platform` job in `.github/workflows/ci.yml`.

### Phase 7 — Advanced edit and orchestration modes

- [x] Wire fenced diff's distinct prompt variant over SEARCH/REPLACE. The
  concrete provider request puts the path inside the active fence while ordinary
  diff keeps it before the fence; a quadruple-backtick application test proves
  the selected fence reaches the example and reminder. Full canonical prompt
  text and per-attempt fence selection remain open in Phase 1.
- [ ] Complete unified-diff behavior. File-header transitions are handled, but
  Aider's indentation, omitted-line, partial-context, and duplicate-hunk
  recovery stages remain absent. Standard no-newline markers preserve, add, or
  remove the final newline according to their position; this intentionally
  fixes pinned aider's marker-tolerance behavior, which loses that meaning.
- [x] Complete Patch actions. Named `@@` scopes anchor the search, repeated
  update blocks merge with an overlap check, and duplicate/conflicting actions
  are rejected. The independent pinned format golden covers an exact update;
  broader upstream Patch behavior is not implied.
- [ ] Integrate architect/editor handoff with explicit user acceptance. A
  library helper exists but is not constructed by `ApplicationService`.
- [ ] Integrate context mode's repeated file selection with a bounded convergence
  loop.
- [ ] Complete cache/continuation/media integration. Prompt-cache boundaries
  and bounded prefill are wired, including DeepSeek prefix normalization, but
  keepalive is unscheduled and repeated truncations accumulate duplicate
  prefixes. Media remains a helper-only context shape.

**Exit (not met):** advanced helpers are not advertised as CLI modes. The six
constructed formats have independent pinned golden/property evidence, but the
advanced orchestration paths remain unintegrated.

**Component evidence only:** `tests/architect.test.ts`,
`tests/context-selection.test.ts`, `tests/capability-context.test.ts`, and the
individual edit-strategy suites.

### Phase 8 — Rich terminal parity

- [x] Connect command and file completion to the executable. Tab completes
  command names and files selected at that keystroke, re-read per completion so
  candidates follow `/add` and `/drop`.
- [x] Connect approved source-identifier candidates to executable completion.
  The application refreshes available non-ignored filenames and extracts
  identifiers only from current editable/read-only source on each completion;
  ignored, stale-dropped, and out-of-root content cannot become candidates.
- [x] Add persistent input/chat history navigation. With
  `--input-history-file` configured the reader seeds recall from it; without the
  option nothing is written and nothing is recalled.
- [x] Add Emacs/Vi bindings and external-editor support to the executable.
  Alt-Enter continues a message across lines and Ctrl-X Ctrl-E edits the whole
  draft in the configured editor. Vi modal editing is not implemented, so
  `--vim` is refused by name rather than accepted and ignored.
- [ ] Complete terminal rendering fidelity. One stateful sanitizer now covers
  every untrusted output path and strips every claimed hostile control family;
  tables, lists, wrapping, and unstable-tail rerendering remain out of scope.
- [x] Dispatch explicitly requested interactive commands through optional
  `node-pty`. `/run --interactive` is the only caller; the native package loads
  at that point and nowhere else, the line reader is released and restored
  around the child, and an interface with no terminal refuses the command.
- [x] Complete shell completions and notification timing/failure handling. The
  completion script is generated from the options the parser registered, so it
  cannot fall behind the executable; `--notifications` fires for a provider turn
  and not for a slash command; and a failing notification command is reported
  instead of ending the input loop. Clipboard text semantics are settled:
  `/paste` submits clipboard text as a user turn without reparsing it as a
  command. Clipboard images remain unread.

**Exit (partial):** command/file/source-identifier completion, recall, multiline, the
external editor, explicit PTY dispatch, generated shell completions, and
provider-turn-only notifications all run through the executable's reader, and
provisioned PTY contract tests cover Ctrl-C, EOF, resize, cleanup, and hostile
child sequences. The renderer stays deliberately smaller than Aider's Rich
renderer: tables, lists, wrapping, and unstable-tail rerendering are out of
scope.

**Evidence:** `tests/cli.test.ts`, `tests/render.test.ts`,
`tests/input-editing.test.ts`, `tests/interactive-command.test.ts`,
`tests/pty-provisioned.test.ts`, and the `pty`
Linux/Windows matrix job in `.github/workflows/ci.yml`. macOS PTY is unsupported
because the provisioned native package fails its spawn contract there.

### Phase 9 — Optional interfaces

- [x] Feed bounded URL fetching into application context. `/web <url>` fetches
  one user-typed URL through the SSRF-safe fetcher, converts HTML to readable
  text without adding a dependency, and adds it to history labeled with the
  final URL and truncated to a share of the input window. URL detection in prose
  and the optional Playwright renderer stay out of the command path.
- [x] Add supported startup for `AI!`/`AI?` watch mode. `--watch-files` shares
  the concrete terminal session and Git ignore predicate; question-only turns
  suppress edits and commands. Node.js local-filesystem notifications are used.
- [x] Add supported startup for the local authenticated HTTP/SSE server through
  the real `ApplicationService`. Partial post-write failures return bounded
  changed paths, a validated commit ID, and command outcomes without raw causes,
  commands, or output.
- [x] Define session expiry, quotas, bounded event/backpressure policy, and
  reclamation. Sessions expire after bounded idle time; total, per-principal,
  message, and SSE-client quotas reject excess work; event replay and each slow
  client's pending bytes are bounded. Loopback HTTP tests directly verify
  disconnect cancellation and overflow recovery.
- [x] Add voice recording/transcription as an optional package subpath and
  embedding adapter without changing the default install footprint. No CLI
  `/voice` or device/recording UX is claimed.

**Exit (met for the documented adapters):** package smoke tests
assert that optional native/browser/audio dependencies do not enter a normal
install. Watch, local API startup, and `/web` ingestion work. A deterministic
concurrent test drives terminal, actual watch submission, and loopback HTTP
through one concrete service and proves their mutation phases do not overlap.
Interface flags are CLI-only and web
cannot run alongside terminal/watch input in the same executable instance.

**Startup and component evidence:** `tests/interface-startup.test.ts`,
packed concrete-service startup in `scripts/package-smoke.mjs`, `tests/url-fetcher.test.ts`,
`tests/watch-mode.test.ts`, `tests/web-server.test.ts`, `tests/voice.test.ts`,
and default-footprint assertions in `scripts/package-smoke.mjs`.

## Verification strategy

### Compatibility fixtures

Use the pinned Python checkout as a development oracle, never a production
dependency. Fixture inputs and normalized expected outputs should be checked
into Patch. Record the upstream commit in every generated fixture set.

The commit alone does not prove where a fixture came from: a dirty checkout
reports the pinned commit too. The exporter therefore refuses an unclean working
tree and verifies committed and on-disk blob hashes for the source files listed
in `upstream.json`. All twelve direct imports now have pinned hashes; Node tests
check the driver's explicit imports and exercise status-hidden changes against
the exporter. Transitive imports and resource hashes are not covered. See
[compatibility fixtures](docs/compatibility-fixtures.md).

Capture at least:

- config precedence and path resolution;
- model aliases/settings and message role normalization;
- prompt chunk order and fence selection;
- whole-file and SEARCH/REPLACE success/failure cases;
- staged plus unstaged Git diffs and dirty checkpoints;
- command effects and state transfer; and
- later, repository-map tags, ranks, and rendered context.

### Test layers

1. **Unit:** parsers, reducers, role normalization, prompt interpolation, path
   checks, token fitting, and provider event assembly.
2. **Property:** edit protocols, line endings, malformed model output, Unicode,
   duplicate context, and path traversal using `fast-check`.
3. **Integration:** real temporary Git repositories and fake providers.
4. **Provider contract:** opt-in tests against supported APIs, never required
   for ordinary CI.
5. **PTY:** interruption, streaming, resize, EOF, timeout, and cleanup.
6. **Package:** `npm pack`, clean temporary install, executable invocation, and
   resource loading from a working directory outside the package.
7. **End to end:** edit a fixture repository, approve changes, inspect diff,
   commit, lint/test, undo, and verify exact repository state.

Tests should assert state and file contents rather than relying primarily on
ANSI snapshots. Every risky behavior needs an asymmetric case where a plausible
wrong implementation produces a different result.

## Highest risks

| Risk | Mitigation |
| --- | --- |
| LiteLLM provider breadth has no exact Node equivalent | Support named providers explicitly behind a normalized event contract. |
| Python truthiness, generators, exceptions, and class attributes do not map directly | Use discriminated unions, explicit `undefined` handling, async iterables, typed effects, and instance fields. |
| Model output is malformed or ambiguous | Dedicated parsers, dry-run resolution, bounded reflection, golden fixtures, and property tests. |
| Writes escape the repository through `..` or symlinks | Canonicalize parent and target paths and enforce containment immediately before every write. |
| Multi-file apply fails halfway | Compute and validate all resulting contents first; each file replacement is atomic, but cross-file rollback remains unsupported and documented. |
| Git differs across worktrees, unborn/detached HEAD, hooks, and partial staging | Use the installed Git CLI and real-repository integration tests. |
| Shell quoting differs across POSIX, PowerShell, and `cmd.exe` | Prefer argv execution, require approval, and test each supported platform explicitly. |
| Tree-sitter grammar/query versions drift | Pin versions together and test every shipped language in the packed npm artifact. |
| Repo-map output is nondeterministic | Stable sort graph inputs and tie-breaks; compare normalized ranking fixtures. |
| Native dependencies make installation fragile | Keep PTY, browser, voice, and native parsers optional and late. |
| Provider streams interleave with commands/watchers | Serialize session mutations and make every long operation abortable. |
| History and logs expose secrets | Create no logs by default, document retention, and redact credentials from diagnostics. |

## Definition of done for parity claims

A feature may be called compatible only when:

- its supported and unsupported behavior is documented;
- behavior tests trace to the pinned upstream source or an intentional Patch
  deviation;
- Linux, macOS, and Windows behavior is tested where platform semantics matter;
- cancellation and failure paths leave files and Git state valid;
- `npm pack` includes every required runtime resource;
- no runtime Python dependency or in-repository aider checkout exists; and
- attribution and modification notices are present.

Full parity is reached only after every registered upstream coder mode, relevant
CLI option, command, provider capability class, Git transition, repository-map
refresh mode, and supported interface has either a passing compatibility test or
a documented intentional difference.

## Initial implementation slice (completed)

The original first slice—package/legal infrastructure, safe text/path adapters,
provider-neutral contracts, SEARCH/REPLACE behavior, and pinned fixtures—is
complete. Its proposed saved-response `--dry-run` CLI was never implemented and
is no longer recommended: dry-run resolution belongs inside the composed turn
lifecycle, where it now runs before authorization and writes. Current work is
tracked by `docs/remaining-integration-tasks.md` rather than this historical
bootstrap sequence.
