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

`GitRepository` exposes tracked files, staged/unstaged/untracked status, unborn
and detached HEAD, combined index/worktree diffs, dirtiness, ignore checks, and
repository-relative paths. Machine-readable filename lists use NUL delimiters,
so whitespace and newline characters cannot corrupt parsing. `.aiderignore` is
passed to Git as an additional excludes file alongside normal Git ignore rules.
Pathspecs are rejected before Git invocation when they escape the worktree.

Selected-file commits stage and commit only explicit pathspecs, preserve
unrelated staged changes, honor hook verification unless `verify` is false, and
support separately attributed author/committer names plus co-author trailers.
Identity overrides are merged into the Git child process environment and never
mutate the parent Node.js `process.env`.
`commitGenerated` supplies the selected diff to an injected model callback when
no message is provided. Every such commit receives a `Patch-Commit: true`
trailer. Undo uses a mixed reset only when the current HEAD carries that marker,
preserving the reverted file contents in the worktree and refusing arbitrary
user commits.
