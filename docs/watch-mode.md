# AI comment watch mode

Start with `patch --watch-files --model 4o file.ts`. This opt-in CLI flag starts
the Node.js recursive filesystem watcher after constructing the concrete service
and terminal session. Save a file containing `// AI! change this` or
`// AI? explain this`; startup does not scan existing comments. The watcher uses
the exact terminal session and its mutation queue, including conversation history.
Responses and edit previews use the shared terminal renderer, whose full
control-sequence sanitization remains a release blocker. No optional native or
browser dependency is loaded.

`AiWatchMode` adapts part of pinned `aider/watch.py`. Changed files are
debounced, deduplicated, contained, and bounded to regular files no larger than
1 MiB. The built-in ignore list is narrower than Aider's canonical editor,
cache, project, and temporary-file rules. Production applies ordinary Git and
root `.aiderignore` checks. Ignore-command failures now suppress the affected
batch rather than exposing a file, but the failure is not surfaced to the user.

Only changed files carrying an actionable marker enter a submission. Aider
reloads current AI comments from every tracked chat file after a trigger; Patch
does not. Production debounce/submission errors are currently discarded and a
native watcher error stops watching without an actionable diagnostic.

Patch intentionally emits line-oriented comment context rather than depending
on upstream's Python Tree-sitter context renderer.

`AI?` uses the configured edit strategy with write/check/command effects
suppressed; it does not switch to Aider's ask prompt. `AI!` uses the normal
write boundary, and a comment does not approve new or out-of-chat writes. Mixed
batches give `AI!` precedence, intentionally differing from Aider's last-marker
arbitration. Watch notifications are not appended to terminal input/chat history
files.

EOF, `/exit`, Ctrl-C, or SIGTERM stops the watcher, cancels pending/active watch
submissions, and closes the concrete service after its session queue settles.
Watcher startup failure also closes the service. Watch cannot be combined with
web or one-shot modes. This is local-filesystem support, not a guarantee of
notifications on network filesystems; native Node watch errors stop watching.

Evidence: `tests/interface-startup.test.ts` exercises real filesystem changes,
Git ignores, shared history, question-only write suppression, selected-file edits,
denied out-of-chat edits, and cleanup. `tests/watch-mode.test.ts` covers bounded
reads, malformed/escaping paths, debounce, and cancellation. The packed startup
path and default dependency footprint are exercised by `scripts/package-smoke.mjs`.
The pinned source is
[`aider/watch.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/watch.py).
