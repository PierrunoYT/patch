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

Current production limitations are release blockers:

- `.aiderignore` is supplied by overriding `core.excludesFile`, not composed
  independently with every existing global excludes policy.
- Ignore-command failures abort the affected startup or turn, but watch-mode
  submission failures still lack an actionable diagnostic.
- The tracked inventory is frozen when the service starts.

Selected-file commit, hook verification, attribution, generated-message, and
marker helpers exist at the adapter level. The concrete application uses fixed
messages, disables hook verification, and does not apply attribution.
Ordinary selected commits preserve unrelated index entries, but commit failure
can replace the selected paths' prior staged state.

Undo keeps working-file content and unrelated index entries, an intentional
Patch safety difference. It reverts only the commit the current session recorded
and moves HEAD through a compare-and-swap `update-ref`, so a commit created by
another session or by the user is refused; root commits, merge commits, and
commits an upstream branch already contains are refused as well. The ownership
check and the reset run under the worktree mutation lock, so no session can
commit between them. A failure between undo's two Git commands is still not
covered by a preservation guarantee.
