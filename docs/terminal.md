# Rich terminal behavior

Patch's terminal behavior is adapted from
[`aider/io.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py)
and intentionally exposed behind terminal-library-neutral TypeScript contracts.

## Completion

`completeInput` supplies deterministic command, repository-file, and source
identifier candidates. Slash commands complete immediately; `/add`, `/drop`,
and `/read-only` use file-only candidates. General file and identifier
completion starts after three characters to avoid a noisy menu, matching the
pinned upstream threshold. `extractIdentifiers` recognizes Unicode identifiers;
callers decide which approved file contents may be scanned.

## Persistent history and privacy

Patch writes no terminal history by default. `--input-history-file <path>`
explicitly enables an append-only JSON Lines file (one JSON string per submitted
input, preserving multiline text). `--chat-history-file <path>` explicitly
enables a Markdown transcript of user messages and string responses returned by
the configured session handler.

Both files can contain source code, prompts, model output, secrets, and personal
data. Patch creates them with owner-only permissions where the platform supports
POSIX modes, but users remain responsible for choosing a private location,
retention, backups, and deletion. History is not redacted or encrypted. Avoid
enabling it in shared or synchronized directories. Disabling the options stops
future writes and does not delete existing files.

## Multiline input, bindings, and editors

Interactive input accepts `{`/`}` blocks and tagged `{name`/`name}` blocks.
`--multiline` instead collects terminal lines through EOF as one message. Emacs
bindings are the default; `--vim` selects Vi semantics. In multiline mode Enter
inserts a newline and Alt-Enter submits; Vi normal-mode Enter submits. Outside
multiline mode those Enter behaviors are reversed. Ctrl-Up/Ctrl-Down navigate
history and Ctrl-X Ctrl-E invokes an external editor.

The editor is selected by `--editor`, then `VISUAL`, then `EDITOR`, with a
platform default. Patch splits the configured command into argv without a shell,
adds a private temporary Markdown file, waits for a successful exit, reads the
result, and removes the temporary directory even after failure.

## Markdown, syntax, and diffs

`MarkdownStream` buffers only incomplete lines, so provider chunks can be
rendered incrementally without breaking Markdown fences. Headings, emphasis,
inline code, and fenced JavaScript, TypeScript, JSON, and shell source receive
lightweight ANSI styling. `renderDiff` distinguishes headers, hunks, additions,
and deletions. Both renderers strip control sequences from untrusted content.

Color is enabled only for a TTY. `--no-color`, a `NO_COLOR` environment value,
or an explicit adapter option disables all ANSI output while preserving text.

## Optional interactive PTY

`runPtyCommand` loads `node-pty` only when interactive execution is requested.
The native package is deliberately absent from Patch's dependency graph. Users
who need PTY execution install `node-pty` alongside Patch explicitly; attempting
PTY execution without it returns a focused `PtyUnavailableError`. Importing the
package, printing CLI help, and non-PTY commands never probe for it. Commands use
executable-plus-argv input and a canonical working directory.

The PTY input contract supports data (including multiline text), Ctrl-C, EOF,
and resize events. Abort kills the child and listeners are disposed at exit.
Child output passes through a stateful sanitizer before streaming or capture;
CSI, OSC, DCS, SOS, PM, APC, C0, and split control sequences cannot alter the
parent terminal.

## Shells, notifications, and clipboard

`patch --shell-completions bash|zsh|fish` prints a deterministic completion
script without starting a session. `--notifications` rings the terminal bell
after a response; `--notifications-command` replaces the bell with an explicit
argv command and never invokes a shell.

`/copy` and `/paste` represent text-only clipboard effects. The adapter uses
`pbcopy`/`pbpaste`, `clip.exe`/PowerShell, `wl-copy`/`wl-paste`, or `xclip` when
available. These native utilities are not npm dependencies and missing commands
produce `ClipboardUnavailableError`. Image clipboard access and richer native
notification APIs remain optional, unsupported enhancements; they do not affect
the portable default installation.
