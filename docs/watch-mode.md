# AI comment watch mode

Start with `patch --watch-files --model 4o file.ts`. This opt-in CLI flag starts
the Node.js recursive filesystem watcher after constructing the concrete service
and terminal session. Save a file containing `// AI! change this` or
`// AI? explain this`; startup does not scan existing comments. The watcher uses
the exact terminal session and its mutation queue, including conversation history.
Responses and edit previews use sanitized terminal output. No optional native
or browser dependency is loaded.

`AiWatchMode` adapts the pinned upstream `aider/watch.py` behavior for `AI!` edit requests and `AI?` questions. Changed files are debounced, deduplicated, safely resolved beneath the repository root, and read only when they are regular files no larger than 1 MiB by default.

Built-in rules skip Git metadata, aider state, dependencies, editor state, environment files, logs, binary documents, and common temporary files. CLI startup composes `ConcreteApplicationService.isIgnored`, using the selected Git repository's `.gitignore` and `.aiderignore` rules. With `--no-git`, only built-in rules apply. Library callers may supply their own `isIgnored` predicate.

The adapter submits work through a shared `SerialTaskQueue`. Terminal, watch, and web callers must use the same queue for a session so a watcher never mutates session state during an active model turn. Debounced work is abortable; stopping watch mode drops pending paths and prevents queued submissions from starting.

Patch intentionally emits line-oriented comment context rather than depending on upstream's Python Tree-sitter context renderer.

`AI?` uses the configured strategy but marks the submission question-only: the
application suppresses proposed edits, commits, checks, and shell commands.
`AI!` uses the normal write boundary; a comment does not approve new or
out-of-chat writes. Mixed batches give `AI!` precedence. Select editable files
at startup; the CLI still has no interactive write/command approval prompt.
Watch notifications are not appended to terminal input/chat history files.

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
