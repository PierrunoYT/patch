# Turn lifecycle and recovery

The concrete application runs each attempt through `CoderSession`'s shared
three-reflection budget. It deep-clones and freezes one attempt context — prompt,
file snapshots, and editable/read-only authorization sets — before the provider
request. The exact context travels with the response through parse, full-batch
resolution, staging, preview/authorization, dirty checkpoint, writes,
auto-commit, lint and linter commit, approved suggested commands, and tests.
Malformed syntax and resolution diagnostics retry before writes. Lint/test
failures retry after writes and commits; each retry reads fresh file snapshots
and rechecks the prompt budget. Linter changes to paths edited in this turn are
committed before reflection. Final results collect changed paths and command
results across attempts and report the latest commit, including check changes.

This is the authoritative production order. A model-selected path absent from
the pre-request inventory receives one contained `null`/content snapshot after
parsing and before resolution; it still passes ignore checks, read-only checks,
dry-run staging, preview, and explicit new/out-of-chat authorization. No live
session selection is consulted after the attempt context is captured. Patch
automatically reflects configured lint/test failures within the shared bound,
rather than adding pinned Aider's per-failure confirmation prompt; this remains
an intentional noninteractive-safe policy difference.

All commit phases share the configured
[commit policy](git-repository.md#production-commit-policy): hook verification,
explicit identity, and opt-in weak-model messages. Generation runs under the
worktree mutation lock before Git staging. A generation failure stops that
commit; earlier writes/checkpoints remain. A failing hook can leave selected
paths staged. Model-edit commits alone receive the configured author/co-author;
checkpoint, manual, and check commits receive only the committer override.

The broad sequence is adapted from pinned
[`base_coder.py`'s provider turn](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1560-L1623)
and [edit boundary](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2240-L2336).
It is not lifecycle equivalence: assistant-mentioned file selection, pre-check
history transition, per-failure choices, and several prompt/state boundaries
differ. Patch also uses these explicit choices:

- Configuring `--lint-cmd` or `--test-cmd` enables automatic bounded corrective
  reflection. There is no per-failure “attempt to fix?” prompt or CLI reflection
  limit option yet. `/lint` and `/test` alone report failures without starting a
  provider turn. Completed configured checks can commit their changes to paths
  edited in this turn; this includes test changes, unlike pinned aider's flow.
- New and out-of-chat edits require `authorizeWrite` from the terminal adapter
  or an embedding caller.
  Read-only paths, including contained aliases, cannot be edited. `/drop` and
  `/add` affect the live authorization selection. User mentions require an
  explicit `approvePath` callback; mere mention does not authorize editing.
  Standalone TTY sessions supply a single terminal approver for writes and
  commands. Exact JSON-quoted literals are displayed; only `y`/`yes` approves.
  Queued/partial input is never consumed for approval, and EOF/Ctrl-C deny.
  Answers bypass model input and persistent history. One-shot, non-TTY,
  redirected output, EOF-multiline, watch, web, and injected-line contexts
  remain deny-by-default. Selected-file edits remain available without a prompt.
- Commands following a failed lint attempt are not run; a correction must
  suggest them again. Each suggested command requires approval. Denial or a
  nonzero exit does not trigger model reflection. A command timeout stops the
  remaining suggested commands; configured tests still run. Captured output
  is bounded but is not automatically added to chat history.
- `/undo` keeps working files and unrelated index entries. It reverts only the
  commit this session recorded, refusing when HEAD has moved, when the commit is
  a root or merge commit, or when its upstream branch already contains it. HEAD
  is moved with a compare-and-swap `update-ref`, so a commit created between the
  checks and the reset is never discarded. A forged `Patch-Commit` marker on a
  commit this session did not create is no longer sufficient, but the following
  `reset HEAD -- <paths>` is a second command: an interruption between the two
  leaves the commit undone with its paths still staged.

## Failure boundaries, not transactional rollback

Authorization, stale snapshots, and cancellation before checkpointing leave
edit files and Git unchanged. The whole snapshot batch is revalidated after
authorization, before checkpointing, and again before application. Repository
map generation can independently create its documented cache file.

Cancellation is checked before mutation phases and between file writes.
An already running Git operation or atomic file replacement finishes; Patch
does not interrupt it halfway. Completed checkpoints/commits survive later
failure and their identifiers remain in session state. Cross-file writes have
**no rollback**: failure or cancellation after the first replacement leaves that
file changed and later files untouched. Inspect the working tree before retrying.
The queue remains reusable and the next turn reads actual disk contents.

Interrupted turns clear pending edits and retain usage and the last completed
commit. History finalization is mutation-aware: when a write reaches the
worktree or a checkpoint/apply commit is created, the application calls
`CoderSession.recordTurnMutation()`, and a later failure or cancellation appends
the user message, every reflection exchange, and the model response that
produced the surviving work. A turn that changed nothing still leaves no trace,
so history never claims edits that do not exist.

The service exposes `TurnPartiallyAppliedError` for failed turns with recorded
changed paths, carrying `changedPaths`, `commit`, and `commands` and naming the
surviving work in its message. The terminal displays that diagnostic. The HTTP
boundary returns an allowlisted structured 500 with bounded safe relative paths,
a validated commit ID, and command status metadata. It omits the cause, message,
command text, and output; some progress may also already have reached SSE.
Checkpoint-only failures can retain a commit in session state without producing
that structured error. Failures without a structured partial result are rethrown
unchanged and remain generic at the HTTP boundary.

Sessions sharing a resolved worktree serialize mutation phases through one
in-process lock. There is no cross-process Patch lock, durable recovery journal,
per-file partial-write result, atomic Git/filesystem transaction, or exhaustive
cancellation guarantee. Git failures after staging and interruption between
undo's two Git commands need further recovery evidence. Approved/configured
child commands are not sandboxed: they can change unrelated files or Git themselves, and Patch
cannot promise to preserve that work against arbitrary command side effects.

## Cleanup ownership

Session close first aborts its lifecycle signal, which cancels active provider
streams and child-process groups, then awaits the serial queue before closing
providers created by model switches. The service owns and closes the startup
provider after every session has drained. Temporary summary/commit providers
close in `finally`. Watch mode owns its native watcher, debounce timer, and any
standalone submissions; web mode owns its listener, connections, SSE clients,
and application sessions. Terminal history owns no persistent descriptor: each
append opens and closes its file in `finally`, and the input loop awaits each
append. Normal exit, cancellation, and startup failure all follow the same
outermost-to-innermost shutdown path. Cleanup failures are aggregated only after
all independent resources have been attempted.

## Evidence

`scripts/lifecycle-smoke.mjs` imports the clean-installed package's concrete
application during `npm run smoke:package`. Its asymmetric real-Git fixture
streams malformed and unresolvable edits, reflects, edits two files, commits,
fails lint once with a linter fix, reflects against fresh context, runs an
approved command, passes tests, and undoes only the last commit. It checks
exact file contents, index contents, commit ancestry, usage, and history.
This is installed **service** evidence with injected provider/approval adapters,
not a claim of interactive standalone-bin approval support.

`tests/terminal-approval.test.ts` separately exercises the executable program
composition with real readline on fake TTY streams and the concrete application:
new/out-of-chat writes, `/run`, model commands, strict answer handling,
queued/partial input, EOF/Ctrl-C, and noninteractive approval gating. Real file
contents and child-command effects are asserted. Native PTY approval-platform
coverage, file-mention prompts, architect acceptance, and per-check reflection
choice remain unsupported; this does not widen the recovery guarantees above.

Local Linux validation on 2026-09-10 also exercised built `dist/cli.js` through
a real OS pseudo-terminal: `/run` displayed the exact command, `yes` created
the expected file, and `/exit` terminated cleanly (`real-linux-pty-ok`). This
manual check is not a provisioned cross-platform approval suite.

`tests/application-lifecycle.test.ts` checks denial, containment, read-only
aliases, stale snapshots, partial writes, rejected/nonzero/timed-out commands,
provider/output truncation, bounded test reflection, and selected cancellation
boundaries with real Git. Map persistence is isolated in failure fixtures;
timeout/output caps are shortened at the process adapter boundary while real
child execution remains in use. These tests do not cover every failure point.
