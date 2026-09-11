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

The interactive reader connects this to Tab. `TerminalInput` takes a
`completionSources` callback and adapts the result to readline's completer
contract; the executable reads the session's editable and read-only paths each
time completion runs, so candidates follow `/add` and `/drop` rather than being
fixed at startup. Command candidates come from `COMMAND_NAMES`, which a test
holds level with what `parseCommand` accepts. A reader built without
`completionSources` leaves input untouched.

## Persistent history and privacy

Patch writes no terminal history by default. `--input-history-file <path>`
explicitly enables an append-only JSON Lines file (one JSON string per submitted
input, preserving multiline text). `--chat-history-file <path>` explicitly
enables a Markdown transcript of user messages and string responses returned by
the configured session handler.

Recall is tied to that same opt-in. When `--input-history-file` is configured,
the reader seeds readline's history from it, so the arrow keys reach inputs from
earlier sessions; without the option nothing is written and nothing is recalled.
Lines that are not valid JSON strings are skipped rather than failing startup,
because the file is appended to by every session and can be truncated mid-write.

Both files can contain source code, prompts, model output, secrets, and personal
data. Patch creates them with owner-only permissions where the platform supports
POSIX modes, but users remain responsible for choosing a private location,
retention, backups, and deletion. History is not redacted or encrypted. Avoid
enabling it in shared or synchronized directories. Disabling the options stops
future writes and does not delete existing files.

## Multiline input, bindings, and editors

The executable's live reader is Node readline. It accepts ordinary lines plus
`{`/`}` and tagged `{name`/`name}` blocks.

Multiline works turn after turn without a mode flag. Alt-Enter holds the current
line and starts another, and a bare Enter submits everything held plus the line
just typed, so one message can span lines and the next turn starts clean.
`--multiline` remains the separate, non-interactive shape: it buffers stdin
through EOF as a single message.

Ctrl-X Ctrl-E opens the whole draft — held lines included — in `--editor`, or
`VISUAL`/`EDITOR`, or the platform default. What comes back is placed at the
prompt rather than submitted, so a final Enter is still required and an editor
that fails leaves the draft intact with the reason printed.

`--vim` remains inert. `terminalKeyBindings` describes Vi's modal Enter, but
Node readline has no modal editing, and honoring it would mean replacing the
line editor outright — cursor motion, wrapping, and terminal-width handling
included. That is deliberately out of scope; the flag should be removed or
refused rather than implying behavior that is absent.

## Markdown, syntax, and diffs

`MarkdownStream` buffers incomplete lines and applies lightweight ANSI styling;
`renderDiff` styles diff structure. The executable uses both for provider text
and edit previews and honors TTY, `--no-color`, and `NO_COLOR`.

Untrusted text passes through one shared sanitizer, `ControlSequenceSanitizer`
in `src/io/sanitize.ts`. It removes C0 controls other than tab, newline, and
carriage return; DEL; the C1 range; 7-bit and 8-bit CSI; OSC, DCS, SOS, PM, and
APC strings with either terminator; single shifts; and escapes carrying
intermediate bytes. `MarkdownStream` holds one sanitizer for the life of a
stream, so a sequence split across provider deltas cannot rejoin; `stripAnsi`
sanitizes one self-contained string for the diff and preview renderers; both
Commander streams and the executable's failure messages are sanitized as well.
Only styling Patch itself emits survives.

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
