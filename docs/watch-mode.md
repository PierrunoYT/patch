# AI comment watch mode

Start with `patch --watch-files --model 4o file.ts`. This opt-in CLI flag starts
the Node.js recursive filesystem watcher after constructing the concrete service
and terminal session. Save a file containing `// AI! change this` or
`// AI? explain this`; startup does not scan existing comments. The watcher uses
the exact terminal session and its mutation queue, including conversation history.
Responses and edit previews use the shared terminal renderer, which sanitizes
untrusted control sequences through one stateful sanitizer. No optional native
or browser dependency is loaded.

`AiWatchMode` adapts part of pinned `aider/watch.py`. Changed files are
debounced, deduplicated, contained, and bounded to regular files no larger than
1 MiB. The built-in ignore list is narrower than Aider's canonical editor,
cache, project, and temporary-file rules. Production applies ordinary Git and
root `.aiderignore` checks. Ignore-command failures abort the affected batch
rather than exposing a file and reach the submission error reporter described
below.

A changed file carrying an actionable marker triggers the turn, and the turn
then refreshes AI comments from every selected file, as Aider does: a comment
written earlier in another file already in the chat rides along instead of being
dropped because only one file changed. A selected file with no comment and a
commented file nobody selected both stay out. Unlike Aider, a changed file is
not added to the chat by the trigger.

Failures are reported rather than discarded. `onError` receives submission
failures and native watcher errors — the terminal prints `Watched turn failed`
or `Watch mode stopped` with the reason — so a failed background turn or a dead
watcher is visible behind the input loop. A reporter that throws is ignored, and
the cancellation that follows a deliberate close is not reported as a failure.

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
notifications on network filesystems; a native Node watch error stops watching
and is reported through `onError`.

Evidence: `tests/interface-startup.test.ts` exercises real filesystem changes,
Git ignores, shared history, question-only write suppression, selected-file edits,
denied out-of-chat edits, and cleanup. `tests/watch-mode.test.ts` covers bounded
reads, malformed/escaping paths, debounce, and cancellation. The packed startup
path and default dependency footprint are exercised by `scripts/package-smoke.mjs`.
The pinned source is
[`aider/watch.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/watch.py).
