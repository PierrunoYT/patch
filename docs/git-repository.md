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

Current production limitations are release blockers:

- `status().trackedPaths` is not filtered through `.aiderignore` before
  application snapshots and repository-map/model context.
- `.aiderignore` is supplied by overriding `core.excludesFile`, not composed
  independently with every existing global excludes policy; ignore command
  failures can fail open.
- The tracked inventory is frozen when the service starts.

Selected-file commit, hook verification, attribution, generated-message, and
marker helpers exist at the adapter level. The concrete application uses fixed
messages, disables hook verification, and does not apply attribution.
Ordinary selected commits preserve unrelated index entries, but commit failure
can replace the selected paths' prior staged state.

Undo keeps working-file content and unrelated index entries, an intentional
Patch safety difference. Its current provenance check accepts any marker-bearing
HEAD and is not bound to a commit owned by the current session; root, merge,
pushed, forged-marker, and interrupted two-command cases need explicit guards.
