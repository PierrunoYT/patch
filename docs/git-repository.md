# Git repository adapter

Patch delegates repository semantics to the installed Git CLI rather than
reimplementing them. `discoverCommonGitRoot` asks Git for each selected path's
worktree, using the nearest existing parent for files that have not been created
yet. It returns one canonical worktree root and rejects a mixture of independent
repositories or repository and non-repository paths.

This behavior is adapted from aider's repository initialization in
[`aider/repo.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py),
modified to use async `git` subprocesses and canonical Node.js paths. It is also
used by staged configuration bootstrap when selected files correct the initial
working-directory root.

`GitRepository` exposes tracked paths, staged/unstaged/untracked status, unborn
and detached HEAD, combined diffs, dirtiness, ignore checks, and
repository-relative paths. Machine-readable filename lists use NUL delimiters.

Git child commands that accept selected pathspecs receive
`GIT_LITERAL_PATHSPECS=1`, so selected names containing wildcard or bracket
syntax remain literal across diff, stage, commit, and undo operations.
`check-ignore` accepts exact pathnames rather than glob patterns and rejects
Git's literal-pathspec magic, so that command is deliberately invoked without
the variable. `tests/git-commit.test.ts` exercises the mutation boundary with a
literal `[ab].txt` beside a matching `a.txt`.

The concrete service batches selected and tracked paths through
`git check-ignore --no-index -z --stdin` before snapshots, mention matching,
repository-map requests, or provider messages. Explicitly selected, command-added,
read-only, and model-targeted ignored paths fail closed before file content is
read. The filter is repeated while composing each turn so changes to ignore
rules cannot expose a previously visible tracked file.

A path is excluded when either policy matches it, which is how upstream keeps
`ignored_file` and `git_ignored_file` separate in `aider/repo.py`. The check
runs once under the repository's ordinary exclusion rules — `.gitignore`,
`.git/info/exclude`, and whatever `core.excludesFile` the user configures — and,
when `.aiderignore` exists, once more with that file supplied as
`core.excludesFile`; the two ignored sets are unioned. Supplying `.aiderignore`
this way replaces the ordinary excludes file for that second invocation only, so
the first invocation is what preserves a global ignore policy. Evidence: the
composition cases in `tests/git-repository.test.ts` and the selection and
provider-context case in `tests/interface-startup.test.ts`.

Ignore-command failures abort the affected startup or turn. Watch-mode
submission failures, including ignore-check errors, reach the error reporter
rather than disappearing silently. The tracked inventory is re-read each turn;
a status failure falls back to the startup inventory, filtered again through
current ignore rules. See [watch mode](watch-mode.md) and
[repository maps](repository-maps.md) for those production paths.

## Production commit policy

Checkpoints, model-edit commits, configured-check commits, and `/commit` share
one policy resolved through CLI, YAML, and `PATCH_*` configuration:

| CLI option / YAML key | Environment | Default and effect |
| --- | --- | --- |
| `--git-commit-verify` / `git-commit-verify` | `PATCH_GIT_COMMIT_VERIFY` | `false`; when true, omit Git's `--no-verify`. |
| `--generate-commit-messages` / `generate-commit-messages` | `PATCH_GENERATE_COMMIT_MESSAGES` | `false`; when true, generate a subject from the selected diff. |
| `--commit-author-name` / `commit-author-name` | `PATCH_COMMIT_AUTHOR_NAME` | Unset; overrides the author name only for model-edit commits. |
| `--commit-committer-name` / `commit-committer-name` | `PATCH_COMMIT_COMMITTER_NAME` | Unset; overrides the committer name for all Patch commits. |
| `--commit-co-author` / `commit-co-author` | `PATCH_COMMIT_CO_AUTHOR` | Unset; adds a `Co-authored-by: <value>` trailer only for model-edit commits. |

Both booleans have `--no-…` counterparts. Names and trailer values must be
nonempty, at most 256 characters, and contain no control characters. Names are
explicit replacements, not suffixes, and do not change Git email addresses.
For a co-author, supply an identity such as `Name <name@example.com>`.
Checkpoint, manual, and configured-check commits do not claim model authorship;
only the committer override applies to them. Child-process environment overrides
never mutate `process.env`. All commits retain `Patch-Commit: true` for undo.

With generation disabled, the existing fixed checkpoint/edit/check messages
remain. `/commit <message>` always uses the user's message without a provider
call; `/commit` alone generates only when enabled. No diff means no generation
and no commit. `--no-git` disables all commit behavior, regardless of policy.

Generation resolves the active model's weak model at request time (the main
model when no separate weak model is configured). Only the selected, currently
non-ignored diff is sent, not chat history, unrelated staged changes, or
attribution settings. This is an additional provider request and may incur
cost. Reported usage, including post-finish usage, emits `commit-message-usage`,
is printed separately by terminal/watch, and contributes to session cost without
replacing the editing turn's usage. The new weak provider is closed afterwards;
an injected shared primary provider remains owned by the service.

The request is limited to the smaller of 8,192 tokens and the model input limit,
with a 256,000-character diff ceiling, at most 128 output tokens (or the model's
smaller limit), and a 30-second abort signal. Output accumulation stops beyond
512 characters. A successful stop and a nonempty, single-line subject of at most
72 characters are required; surrounding whitespace and paired quotes are
removed. Truncation, malformed output, and provider failure abort the commit
before staging. Recover with `/commit <message>` or restart with generation
disabled. If edits already reached disk, they remain and the normal structured
partial-turn error/history reconciliation applies. Generation is cancellable;
an already-running Git operation still finishes rather than being interrupted.

### Intentional differences from pinned Aider

Compared again with [`aider/repo.py:131–373`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L131-L373),
[`aider/args.py:439–508`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/args.py#L439-L508),
and [`aider/prompts.py:8–23`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/prompts.py#L8-L23):
Patch keeps generation and attribution opt-in rather than adding provider cost
or modifying identity by default. It uses explicit identity values rather than
Aider's implicit author/committer/co-author precedence and branding. Generated
subjects follow the same concise conventional-message intent, but there is no
conversation context, custom/language prompt, retry/model-fallback chain, or
placeholder commit on generation failure. Independent auto/dirty-commit toggles
are not exposed; Git-enabled sessions retain both. These are bounded production
controls, not full Aider commit-policy parity.

### Hooks and recovery limits

Enabling verification authorizes the repository's Git hooks to execute without
a per-hook prompt. Hooks are not sandboxed, may alter files or Git state, and
can block; Patch does not impose a Git-hook timeout. `--no-verify` skips only
the hooks Git documents for that switch, notably `pre-commit` and `commit-msg`;
it does not disable `prepare-commit-msg` or `post-commit`.
Before staging selected paths, Patch saves their exact stage entries. If `git
commit` fails, it removes only those selected entries and restores their prior
blobs/stages with `git update-index --index-info`; working files and every
unrelated index entry remain untouched. This preserves partially staged
selected files and restores a newly added path to untracked. If restoration
itself fails, the error reports both failures and the user must inspect the
index. Index flags such as `assume-unchanged`/`skip-worktree` are outside this
guarantee. Hooks and configured/approved commands can independently modify any
file or Git state, and Patch does not reverse those arbitrary side effects.

Evidence: `tests/config-bootstrap.test.ts` checks precedence and malformed
configuration; `tests/application-lifecycle.test.ts` exercises the executable
program with real Git hooks, distinct checkpoint/edit/check attribution,
selected-diff privacy, cost, explicit messages, no-op commits, output bounds,
generation cancellation, pre-/post-write failures, exact index restoration,
and staged/unstaged preservation. The installed service
scenario in `scripts/lifecycle-smoke.mjs` verifies generated messages, hook
execution, and committer identity from the packed package. Providers are fake;
this does not establish live-provider or new cross-platform evidence.

Local Linux verification (2026-09-11): `npm run check` passed with 498 tests
passed and four gated tests skipped, plus format, lint, typecheck, build, and
packed-install checks (`installed-commit-policy-ok`, `installed-lifecycle-ok`).
`npm start -- --help` exposes the new policy controls. The dated audit remains
unchanged as a historical snapshot.

## Undo

Undo keeps working-file content and unrelated index entries, an intentional
Patch safety difference. It reverts only the commit the current session recorded
and requires that exact commit ID at the adapter boundary as well as in the
application. `undoLastPatchCommit(expected)` has no optional ownership bypass;
untyped callers omitting the argument are rejected before mutation. Tests in
`tests/git-commit.test.ts` cover missing/invalid ownership and a later
marker-bearing HEAD, retaining HEAD, index entries, and working content on refusal.
This follows pinned `aider/commands.py:570–579`'s session-ownership requirement;
Patch still preserves working content rather than checking it out from the parent.
Undo moves HEAD through a compare-and-swap `update-ref`, so a commit created by
another session or by the user is refused; root commits, merge commits, and
commits an upstream branch already contains are refused as well. The ownership
check and the reset run under the worktree mutation lock, so no session can
commit between them. A failure between undo's two Git commands is still not
covered by a preservation guarantee.
