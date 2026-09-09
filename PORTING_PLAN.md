# Aider-to-Patch TypeScript Porting Plan

## Source baseline

Patch will port behavior from the canonical
[`Aider-AI/aider`](https://github.com/Aider-AI/aider) repository at commit
[`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`](https://github.com/Aider-AI/aider/tree/5dc9490bb35f9729ef2c95d00a19ccd30c26339c).
The reference checkout is `/home/user/workspace/aider-upstream`, outside this
repository. It must remain outside this repository and must not become a
submodule.

At this baseline, aider contains approximately 20,285 lines in 80 Python
modules and 36 test modules. Patch currently contains documentation and brand
assets but no application implementation, so this is a greenfield TypeScript
port rather than an incremental conversion.

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

### Later parity

- Repository maps and additional Tree-sitter languages.
- Unified diff, patch, architect/editor, context, and help modes.
- Rich terminal completion, multiline input, Vi bindings, clipboard, PTY, and
  notifications.
- More providers, prompt caching, assistant-prefill continuation, images, and
  PDFs.
- File watch mode, URL scraping, browser UI, and voice input.
- Analytics, onboarding, update checks, and release-note prompts only if Patch
  has a product requirement for them.

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
  cli/                 argument definitions and staged bootstrap
  config/              config discovery, merge, validation
  core/                messages, session state machine, prompts, history
  edits/               whole-file, search/replace, later patch/udiff
  models/              model registry, capabilities, token/cost metadata
  providers/           OpenAI-compatible, Anthropic, fake provider
  repository/          Git CLI adapter, ignore rules, safe paths
  context/             file context and later repository maps
  commands/            typed slash-command registry
  io/                  filesystem and terminal adapters
  processes/           lint, test, shell, and later PTY adapters
  resources/           model settings, prompts, and later query files
  index.ts              public application factory
  cli.ts                npm executable
tests/
  unit/
  integration/
  compatibility/
  fixtures/
```

Runtime resources belong under `src/resources/` and in the npm package `files`
list. `assets/` remains branding-only.

### Core contracts

Define these before implementing adapters:

```ts
interface ModelProvider {
  stream(request: CompletionRequest, signal?: AbortSignal):
    AsyncIterable<CompletionEvent>;
}

interface EditStrategy {
  readonly format: EditFormat;
  buildPrompts(model: ModelConfig): PromptSet;
  parse(response: AssistantResponse, context: EditContext): Edit[];
  apply(edits: Edit[], context: EditContext): Promise<Set<string>>;
}

interface Repository {
  readonly root: string;
  trackedFiles(): Promise<string[]>;
  isIgnored(path: string): Promise<boolean>;
  isDirty(path?: string): Promise<boolean>;
  diff(paths?: string[]): Promise<string>;
  commit(request: CommitRequest): Promise<CommitResult | undefined>;
}

type CommandEffect =
  | { type: "none" }
  | { type: "submit"; message: string }
  | { type: "switch"; config: SessionConfigPatch }
  | { type: "exit"; code: number };
```

All session state must be initialized per instance. In particular, do not copy
the class-level mutable fields in
[`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L88-L123).

The turn state machine should be explicit and serial:

```text
waiting for input
  → preprocess command, file mentions, and URLs
  → compose messages and check context budget
  → stream provider response with cancellation/retry
  → parse proposed edits
  → preview and authorize paths
  → checkpoint pre-existing dirty files
  → apply edits
  → auto-commit
  → lint and optionally reflect
  → approve/run suggested shell commands
  → test and optionally reflect
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
| Ignore rules | Git CLI plus `ignore` for `.aiderignore` | Parse NUL-delimited Git output. |
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
- [x] Add CI for typecheck, lint, tests, build, and `npm pack` smoke testing.
- [x] Build an upstream fixture exporter outside the shipped package. Capture
  normalized outputs from pinned aider for config precedence, prompt chunks,
  edit parsing/application, Git state, and repository maps.
- [x] Define schemas for messages, provider events, edits, repository results,
  command effects, model settings, and session state.
- [x] Add a deterministic fake provider that can stream text, reasoning,
  fragmented tool calls, usage, retryable errors, truncation, and cancellation.

**Exit:** `npm ci`, typecheck, tests, build, pack, clean-install, and `patch
--help` work without Python.

### Phase 1 — Files, configuration, and messages

- [x] Implement safe path resolution that rejects writes outside the selected
  root after symlink resolution.
- [x] Implement encoding, LF/CRLF preservation, dry-run writes, and atomic file
  replacement.
- [x] Port shared prompt resources and fence selection.
- [x] Implement chat roles and the upstream chunk order: system, examples,
  read-only files, repository map, old history, editable files, current turn,
  reminder.
- [x] Implement provisional Git-root discovery, config search, preliminary CLI
  parse, dotenv loading, final parse, and true-root correction.
- [x] Specify and test precedence among defaults, home config, repository
  config, working-directory config, `.env`, environment, and CLI.
- [x] Load and validate model aliases, model settings, and JSON5 metadata from
  packaged resources.

**Exit:** compatibility fixtures prove config and message composition behavior;
filesystem tests cover Unicode, spaces, symlinks, missing files, and both line
endings.

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
- [x] Implement bounded reflection for malformed edits, lint failures, and test
  failures. Default to aider's maximum of three reflections.
- [ ] Implement file-mention detection and explicit approval before adding or
  editing unselected files.
- [ ] Implement strategy/model switching with state transfer. Summarize or
  clear incompatible assistant protocol examples when the edit format changes.
- [ ] Add one-shot `--message`, `--message-file`, and interactive line input.

**Exit:** a fake-provider end-to-end test completes a streamed multi-turn edit,
handles one malformed response through reflection, and cancels without writing
partial output.

### Phase 4 — Real model providers

- [ ] Implement OpenAI Chat Completions-compatible streaming, custom base URL,
  API key, timeout, request options, usage, and finish reasons.
- [ ] Implement Anthropic streaming and system/cache-control differences.
- [ ] Implement main, weak, and editor model selection without recursive
  construction bugs.
- [ ] Add provider-specific credential diagnostics and supported-capability
  checks.
- [ ] Add model-aware token counting where reliable and conservative estimates
  elsewhere.
- [ ] Track usage and estimated cost while clearly labeling unknown pricing.
- [ ] Publish a provider compatibility table; reject unsupported providers
  explicitly.

**Exit:** opt-in provider integration tests pass when credentials are present;
all ordinary CI tests use deterministic fakes and require no network.

### Phase 5 — Git, authorization, and commands (MVP)

- [ ] Discover one common Git worktree for selected paths and reject paths from
  multiple repositories.
- [ ] Implement tracked files, staged/unstaged status, unborn and detached HEAD,
  `.gitignore`, `.aiderignore`, diffs, and repository-relative paths using
  NUL-delimited Git output.
- [ ] Implement the write boundary: preview, authorize new/out-of-chat paths,
  checkpoint dirty files, apply, and report changed files.
- [ ] Implement selected-file commits, optional hook verification, attribution,
  model-generated commit messages, and undo constrained to Patch commits.
- [ ] Never mutate global `process.env` for commit identity; pass environment to
  that Git child process.
- [ ] Implement typed commands for `/add`, `/drop`, `/read-only`, `/ls`,
  `/clear`, `/model`, `/chat-mode`, `/run`, `/test`, `/lint`, `/commit`,
  `/undo`, and `/exit`.
- [ ] Require approval for each model-suggested shell command, show the exact
  command, run at repository root, cap output, and support timeout/cancellation.
- [ ] Run only user-configured lint/test commands; do not guess package-manager
  commands in an arbitrary target repository.

**Exit — first usable release:** an npm-installed binary can safely edit a real
Git repository with OpenAI-compatible or Anthropic models using `ask`, `whole`,
or `diff`, including preview, approval, commit, undo, lint, test, and reflection.

### Phase 6 — Repository maps

- [ ] Port definitions/references extraction with `web-tree-sitter`.
- [ ] Initially support JavaScript, TypeScript, Python, Go, and Rust.
- [ ] Keep query files and WASM grammars under `src/resources/repomap/` or use
  version-pinned npm grammar packages; never place them in `assets/`.
- [ ] Build the weighted reference graph and deterministic personalized
  PageRank.
- [ ] Port token-budget binary search and a TypeScript `TreeContextRenderer`
  equivalent to `grep_ast.TreeContext`.
- [ ] Add mtime/content-keyed cache files, corruption recovery, and `manual`,
  `always`, `files`, and `auto` refresh behavior.
- [ ] Compare normalized map output and rank ordering against upstream fixtures.
- [ ] Add languages only with pinned grammar/query compatibility tests and npm
  package smoke coverage.

**Exit:** representative multi-language fixtures produce stable, useful maps
within token budgets on Linux, macOS, and Windows.

### Phase 7 — Advanced edit and orchestration modes

- [ ] Port fenced diff as a prompt variant over SEARCH/REPLACE.
- [ ] Port unified diff with no-match versus non-unique-match diagnostics.
- [ ] Port patch add/delete/update/move actions and fuzz accounting.
- [ ] Port architect/editor handoff with explicit user acceptance.
- [ ] Port context mode's repeated file selection with a bounded convergence
  loop.
- [ ] Add prompt caching, cache keepalive, assistant-prefill continuation,
  images, and PDF read-only context where provider capabilities allow it.

**Exit:** each format has independent golden and property tests, and switching
formats cannot leak incompatible protocol examples into subsequent prompts.

### Phase 8 — Rich terminal parity

- [ ] Add command, file, and identifier completion.
- [ ] Add persistent input/chat history with explicit paths and privacy notes.
- [ ] Add multiline input, Emacs/Vi bindings, and external-editor support.
- [ ] Add markdown streaming, syntax highlighting, diff previews, and no-color
  behavior.
- [ ] Add optional `node-pty` execution for interactive commands and verify
  control-sequence sanitization.
- [ ] Add shell completions, notifications, and clipboard text; keep native or
  image clipboard features optional.

**Exit:** PTY tests cover Ctrl-C, EOF, resize, multiline input, process cleanup,
and hostile child control sequences.

### Phase 9 — Optional interfaces

- [ ] Add URL fetching with size limits, timeouts, content-type checks, and SSRF
  protection; make Playwright an optional enhancement.
- [ ] Add `AI!`/`AI?` watch mode with ignore rules, file-size limits, debounce,
  and serialized interaction with active model turns.
- [ ] Expose the same application service through a local authenticated web
  server and SSE/WebSocket events. Keep session state isolated per user/session.
- [ ] Add voice recording/transcription only as an optional package because
  native audio and ffmpeg complicate npm installation.

**Exit:** optional features do not increase the install footprint or native
build requirements of the default CLI package.

## Verification strategy

### Compatibility fixtures

Use the pinned Python checkout as a development oracle, never a production
dependency. Fixture inputs and normalized expected outputs should be checked
into Patch. Record the upstream commit in every generated fixture set.

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
| Multi-file apply fails halfway | Compute and validate all resulting contents first, then atomically replace files with rollback. |
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

## Recommended first implementation slice

Do not begin by porting `main.py` or the full `Coder` class. The first reviewable
slice should be:

1. [x] package/build/test/legal foundation;
2. safe text-file and path adapters;
3. [x] provider-neutral message and edit types;
4. SEARCH/REPLACE parser and applicator;
5. golden fixtures from upstream `test_editblock.py`; and
6. a tiny CLI that applies a saved model response in `--dry-run` mode.

This slice tests the hardest product-specific contract without prematurely
committing to a provider SDK, terminal framework, or large session hierarchy.
