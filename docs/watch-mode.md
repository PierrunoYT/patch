# AI comment watch mode

`AiWatchMode` adapts the pinned upstream `aider/watch.py` behavior for `AI!` edit requests and `AI?` questions. Changed files are debounced, deduplicated, safely resolved beneath the repository root, and read only when they are regular files no larger than 1 MiB by default.

Built-in rules skip Git metadata, Patch/aider state, dependencies, editor state, environment files, logs, binary documents, and common temporary files. Callers can supply `isIgnored` (normally `GitRepository.isIgnored`) for repository and `.aiderignore` rules.

The adapter submits work through a shared `SerialTaskQueue`. Terminal, watch, and web callers must use the same queue for a session so a watcher never mutates session state during an active model turn. Debounced work is abortable; stopping watch mode drops pending paths and prevents queued submissions from starting.

Patch intentionally emits line-oriented comment context rather than depending on upstream's Python Tree-sitter context renderer.
