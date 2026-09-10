# Plan 2 — Application composition root and functional CLI

## Objective

Turn Patch's existing configuration, provider, session, edit, repository, and
process components into one usable terminal application. The first integrated
slice must support a real model turn, repository context, streamed output, and
authorized edits without prematurely claiming the complete Git/check lifecycle
or unsupported coder modes.

## Current constraint

The executable currently accepts `--message`, `--message-file`, or interactive
line input, but its default message handler reports that no model provider is
configured. Most application capabilities are available only as independently
tested modules. This plan creates the missing composition layer rather than
duplicating those modules.

## Implementation sequence

### 1. Define the application service

- Add one application-level owner that constructs and coordinates configuration,
  repository, filesystem, models, providers, edit strategies, prompt context,
  checks, and `CoderSession`.
- Keep Commander and terminal interaction as adapters; neither should own
  session or repository behavior.
- Serialize model turns and command effects through one async mutation queue.
- Accept dependencies at the boundary so integration tests can use
  `FakeProvider` and deterministic approval/output adapters.

### 2. Unify startup and CLI configuration

- Route startup arguments through `bootstrapConfiguration` instead of defining
  an unrelated subset in `createProgram`.
- Expose only controls supported by the application service: model/provider,
  editable and read-only paths, edit format, Git enablement, lint/test commands,
  message input, and safe approval policy.
- Preserve config-file, dotenv, environment, and command-line precedence.
- Remove the placeholder provider handler once the application service owns
  message submission.
- Diagnose missing credentials and unsupported providers or options before
  opening an interactive session.

### 3. Add model and strategy construction

- Load `ModelCatalog`, resolve the selected main model, run provider preflight,
  and construct the OpenAI, Anthropic, or DeepSeek adapter.
- Add an explicit strategy factory for formats that have working parsers:
  `ask`, `whole`, `diff`, `diff-fenced`, `udiff`, and `patch`.
- Reject schema-only or incomplete modes clearly until they have full behavior.
- Attach each strategy's format-specific system instructions, examples, and
  reminders. Do not rely on the edit-format enum as proof that a mode exists.

### 4. Build repository and file context

- Resolve the selected root and paths through `SafePathResolver` and
  `FileSystemAdapter`.
- Open `GitRepository` only when Git is enabled and validate one common
  worktree for all selected paths.
- Load editable and read-only text into prompt chunks and immutable edit
  snapshots.
- Obtain tracked files and generate a repository map when enabled by the model.
- Rebuild per-turn context from current disk and repository state so edits are
  never resolved against stale startup content.
- Keep unsupported media out of text context; capability-aware media loading can
  be integrated only after its file-size and containment boundaries are defined.

### 5. Execute one complete minimal turn

- Submit user input through `CoderSession` and stream normalized text events to
  the terminal adapter.
- Parse and dry-run resolve the complete response against the turn snapshots.
- Stage the resulting transaction before asking for write authorization.
- Present a deterministic preview and request explicit approval for every new
  or out-of-chat path.
- Apply approved edits through `applyAuthorizedEdits` and report changed paths.
- Leave denied, malformed, stale, cancelled, or truncated turns without file
  mutations.
- Do not wire lint/test reflection through the current pre-write callbacks. The
  full apply/commit/check sequence belongs to the next milestone.

### 6. Connect interactive input and commands

- Send one-shot and non-command interactive input to the same application
  service.
- Parse slash commands before model submission.
- Initially dispatch commands whose complete safe behavior can be supported,
  including `/add`, `/drop`, `/read-only`, `/ls`, `/clear`, and `/exit`.
- Return an explicit unsupported-operation diagnostic for effects that still
  lack lifecycle integration; do not silently accept inert `/commit`, `/undo`,
  `/lint`, `/test`, `/run`, `/model`, or `/chat-mode` effects.
- Ensure Ctrl-C cancels only the active turn and leaves the session able to
  accept subsequent input.

### 7. Add the full post-edit lifecycle

After the minimal turn is stable, implement the pinned Aider ordering as one
cohesive workflow:

1. resolve, stage, preview, and authorize edits;
2. checkpoint pre-existing dirty selected files;
3. apply edits;
4. auto-commit changed files when enabled;
5. lint changed files and optionally reflect, committing linter changes;
6. preview and approve each model-suggested shell command;
7. run configured tests and optionally reflect; and
8. return to waiting state with commit, usage, and history state updated.

Application tests must assert this ordering. Checks must observe edited disk
content, and a reflected response must repeat the edit lifecycle rather than
running checks against an unapplied candidate.

## Verification

### Focused tests

- Unit-test startup/model/strategy factories and unsupported-mode diagnostics.
- Test prompt construction with editable files, read-only files, history, and a
  repository map in canonical chunk order.
- Test command dispatch and queue serialization independently of terminal I/O.

### Integration tests

- Run config-to-session assembly with `FakeProvider` and a temporary Git
  repository.
- Exercise one-shot ask mode and a multi-turn interactive conversation.
- Stream an edit, inspect its preview, authorize it, and verify exact file
  contents.
- Verify authorization denial, malformed output, stale snapshots, provider
  failure, and cancellation leave every file unchanged.
- Exercise the full post-edit lifecycle with asymmetric file changes and
  deterministic fake lint/test/command outcomes.
- Verify checkpoint, selected-file commit, and marker-constrained undo against
  exact temporary-repository state.

### Package checks

- Run `npm run check`.
- Build and install the packed tarball in a clean temporary project.
- Invoke help, one-shot ask mode, and one authorized fake-provider edit from a
  working directory outside the package.
- Keep ordinary checks credential-free; add separately gated live provider
  contract tests for supported APIs.

## Documentation updates required with implementation

- Update `README.md` with the first workflow that genuinely works from the
  executable and list unsupported modes explicitly.
- Update configuration, provider, input, command, session, and edit-strategy
  documentation for the assembled behavior.
- Update `CHANGELOG.md` and only mark `PORTING_PLAN.md` tasks complete when their
  executable behavior and exit tests pass.

## Completion criteria

This plan is complete when an npm-installed `patch` executable can load its
configuration, construct a supported provider and edit strategy, assemble real
repository context, complete serialized one-shot and interactive turns,
preview and authorize contained edits, apply and commit them in the documented
order, run configured checks and approved commands, reflect on failures, and
undo its own last commit. The complete validation suite and package smoke test
must pass without Python or live credentials.
