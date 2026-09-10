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

The executable's live reader is Node readline. It accepts ordinary lines plus
`{`/`}` and tagged `{name`/`name}` blocks. Current `--multiline` buffers stdin
through EOF as one message; it is not Aider's multi-turn Enter/Alt-Enter editor.

`completeInput`, `terminalKeyBindings`, history-navigation actions, and
`editInExternalEditor` are exported helper contracts only. The executable does
not call them. Consequently `--vim` and `--editor` are currently accepted but
inert, Ctrl-Up/Ctrl-Down do not load the configured JSONL history, and Ctrl-X
Ctrl-E does not launch an editor. These flags must be removed or refused until
one live terminal adapter wires the corresponding behavior.

## Markdown, syntax, and diffs

`MarkdownStream` buffers incomplete lines and applies lightweight ANSI styling;
`renderDiff` styles diff structure. The executable uses both for provider text
and edit previews and honors TTY, `--no-color`, and `NO_COLOR`.

The current renderer strips CSI and OSC patterns but not every control family
claimed by the earlier documentation. DCS/SOS/PM/APC, standalone controls, and
split sequences require the stateful sanitizer already used for PTY output.
Until that is shared, untrusted provider/diff output is not fully terminal-safe.
The renderer is intentionally smaller than Aider's Rich renderer and does not
provide full tables, lists, wrapping, or unstable-tail rerendering.

## Optional interactive PTY

`runPtyCommand` is a library helper with dynamically loaded `node-pty`; no
executable command or flag currently dispatches through it. The native package
is deliberately absent from Patch's dependency graph. Importing Patch, printing
CLI help, and non-PTY commands never probe for it.

At the helper boundary, commands use executable-plus-argv input and a canonical
working directory. Data, Ctrl-C, EOF, resize, abort, and capture are modeled;
child output passes through a stateful sanitizer. Provisioned contract tests
cover Linux and Windows. The pinned native package fails its spawn contract on
the current macOS runner, so no macOS PTY support is claimed.

## Shells, notifications, and clipboard

`patch --shell-completions bash|zsh|fish` prints a script, but its hard-coded
option inventory omits several active CLI options. `--notifications` currently
runs after any successfully handled line, including slash commands, rather than
only after provider turns. A configured notification-command failure is not
isolated and can terminate the input loop.

`/copy` and `/paste` represent text-only clipboard effects. The adapter uses
`pbcopy`/`pbpaste`, `clip.exe`/PowerShell, `wl-copy`/`wl-paste`, or `xclip` when
available. These native utilities are not npm dependencies and missing commands
produce `ClipboardUnavailableError`. Image clipboard access and richer native
notification APIs remain optional, unsupported enhancements; they do not affect
the portable default installation.
