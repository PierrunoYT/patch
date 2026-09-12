# Rich terminal behavior

Patch's terminal behavior is adapted from
[`aider/io.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py)
and intentionally exposed behind terminal-library-neutral TypeScript contracts.

## Input modes

Input sequencing also adapts pinned
[`aider/main.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py)
for asynchronous Node.js streams:

- `patch --message "..."` submits exactly one message and exits.
- `patch --message-file path` reads the complete UTF-8 file, submits it once,
  and exits. The two one-shot options are mutually exclusive.
- With neither option, ordinary terminal input submits non-empty messages
  serially until EOF or `/exit`; multiline forms are described below.
- `--multiline` buffers stdin through EOF as one message rather than opening
  the interactive editor.
- Watch shares a terminal session; web starts a separate local API instead of
  terminal input. Neither can be combined with one-shot input, and they cannot
  be combined with each other. See [watch mode](watch-mode.md) and
  [the web interface](web-interface.md).

Package smoke verifies both provider-bearing terminal modes through the actual
`patch` bin after packing and clean installation. A preloaded deterministic
`fetch` replacement returns OpenAI-compatible SSE entirely in-process: one run
uses `--message`, and another sends two lines plus `/exit` and rejects the second
request unless it contains the first user/assistant exchange. No socket,
external network, or live credential is used. A malformed SSE run must exit
nonzero and omit the fake's private sentinel; this is executable-path evidence,
not a live-provider claim. The preload is handed to `--import` as a `file://`
URL, because Node's ESM loader rejects a bare Windows absolute path as an
unsupported `c:` scheme; the smoke therefore runs on every CI platform, not
only POSIX.

Input acquisition can use an injected message handler for tests and embedding
hosts. Without one, `createProgram` constructs `ConcreteApplicationService`
before reading input. A model is mandatory; supported provider credentials are
resolved from the staged environment, and missing model/credentials fail before
the input loop. Default Git-enabled startup requires an existing worktree
unless `--no-git` is supplied. See
[configuration bootstrap](configuration-bootstrap.md) for precedence and
[turn lifecycle](turn-lifecycle.md) for approval policy.

## Completion

`completeInput` supplies deterministic command, repository-file, and source
identifier candidates. Slash commands complete immediately; `/add`, `/drop`,
`/read-only`, and `/attach` use file-only candidates. General file and identifier
completion starts after three characters to avoid a noisy menu, matching the
pinned upstream threshold. `extractIdentifiers` recognizes Unicode identifiers;
callers decide which approved file contents may be scanned.

The interactive reader connects this to Tab. `TerminalInput` takes a
`completionSources` callback and adapts the result to readline's completer
contract. The executable asks the application session on every Tab press for
current tracked, non-ignored filenames and identifiers extracted only from the
current editable/read-only files, so candidates follow `/add`, `/drop`, disk
edits, and repository inventory changes rather than being fixed at startup.
Source text never crosses the completion contract. A newly ignored file is
filtered again, and safe filesystem reads prevent out-of-root source from being
scanned. This follows pinned `aider/io.py` in tokenizing in-chat/read-only source
while intentionally applying Patch's stricter containment and ignore policy.
Command candidates come from `COMMAND_NAMES`, held level with `parseCommand` by
a test. A reader built without `completionSources` leaves input untouched.

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
`VISUAL`/`EDITOR`, or the platform default. The reader is released for the
editor exactly as it is for an interactive command, since the editor inherits
the terminal, and is rebuilt afterwards. What comes back is placed at the prompt
rather than submitted, so a final Enter is still required; an editor that fails
leaves the draft and every held line intact with the reason printed, and the
temporary file is removed either way.

Ctrl-C abandons what is being typed, held lines included, before the interrupt
handler runs. Node's readline emits `SIGINT` without touching the buffer, so an
abandoned line would otherwise reappear in front of the next one. In the
executable the interrupt also stops the CLI; an embedding caller that keeps the
session alive gets a clean prompt. Ctrl-C at an approval prompt denies it, so a
caller whose interrupt keeps the reader open does not leave the approval waiting
for an answer nothing will supply. Ctrl-D on an empty line ends input.

`--vim` is refused with the reason rather than accepted and ignored.
`terminalKeyBindings` still describes Vi's modal Enter, but Node readline has no
modal editing, and honoring it would mean replacing the line editor outright —
cursor motion, wrapping, and terminal-width handling included. That is
deliberately out of scope, so passing the flag fails startup and names
Ctrl-X Ctrl-E as what Patch offers instead. The option is hidden from `--help`
and from shell completion, because a flag that always fails is not a feature.

## Markdown, syntax, and diffs

`MarkdownStream` buffers incomplete lines and applies lightweight ANSI styling;
`renderDiff` styles diff structure. The executable uses both for provider text
and edit previews and honors TTY, `--no-color`, and `NO_COLOR`.

Untrusted text passes through one shared sanitizer, `ControlSequenceSanitizer`
in `src/io/sanitize.ts`. It removes C0 controls other than tab, newline, and
carriage return; DEL; the C1 range; 7-bit and 8-bit CSI; OSC, DCS, SOS, PM, and
APC strings with either terminator; single shifts; and escapes carrying
intermediate bytes. Only the five C1 bytes that actually open a string are
treated as introducers; ST and the rest are dropped as ordinary controls, since
treating a terminator as an introducer would discard the remainder of a stream
that a single mojibake byte had wandered into. The bidirectional embeddings,
overrides, and isolates are removed as well: they reorder how a command or path
reads without changing a byte of it. Other format characters stay, because a
zero-width joiner builds ordinary glyphs rather than disguising them. `MarkdownStream` holds one sanitizer for the life of a
stream, so a sequence split across provider deltas cannot rejoin; `stripAnsi`
sanitizes one self-contained string for the diff and preview renderers; both
Commander streams and the executable's failure messages are sanitized as well,
as are the interpolated parts of the terminal's own status lines — the fetched
URL, a watch-mode failure, a failed notification command — since those quote a
path, a URL, or child output. Only styling Patch itself emits survives.

The renderer is intentionally smaller than Aider's Rich renderer and does not
provide full tables, lists, wrapping, or unstable-tail rerendering.

## Optional interactive PTY

`/run --interactive <command>` is the only path that dispatches through
`runPtyCommand`. Upstream picks a PTY from the environment; Patch requires the
user to ask for one, so nothing acquires the keyboard implicitly. `--` ends the
flags, so `/run -- --interactive x` runs a command that starts with a dash.

A model-suggested command never reaches this path — only a command the user
typed does — and approval is the same JSON-quoted prompt the captured path uses,
taken before the terminal is handed over. Only the standalone interactive TTY
startup supplies the runner; `--web`, `--watch-files`, one-shot, and embedded
callers refuse `/run --interactive` by name instead of running it with no
terminal attached. The command string is interpreted by the same shell
`spawn(..., { shell: true })` would choose: `/bin/sh -c` elsewhere, `%ComSpec%
/d /s /c` on Windows.

While the child runs, the line reader is closed rather than paused, because a
live readline interface keeps consuming and echoing keystrokes that belong to
the child. A fresh reader afterwards restores the prompt, the recall history,
and the draft that was being typed. Keystrokes are forwarded verbatim, so
Ctrl-C and Ctrl-D mean whatever the child's own line discipline makes of them,
and terminal resizes are forwarded for the life of the command.

Child output is still sanitized, exactly as captured output is. A command cannot
repaint, retitle, or otherwise drive the terminal, so full-screen programs are
not usable through this path; interactive dispatch serves prompts, REPLs, and
other line-oriented sessions. Relaxing that would hand terminal control to a
subprocess, which the sanitizer exists to prevent.

The native package is deliberately absent from Patch's dependency graph and is
loaded only when this command runs. Importing Patch, printing CLI help, and
every non-interactive command never probe for it; without it the command fails
with `PtyUnavailableError` naming the optional package.

At the helper boundary, commands use executable-plus-argv input and a canonical
working directory. Data, Ctrl-C, EOF, resize, abort, and capture are modeled.
Provisioned contract tests cover Linux and Windows. The pinned native package
fails its spawn contract on the current macOS runner, so no macOS PTY support is
claimed.

## Shells, notifications, and clipboard

`patch --shell-completions bash|zsh|fish` prints a script whose option inventory
comes from the parser itself, so it cannot fall behind the executable; a test
holds the two level. Hidden options — today only `--vim` — are excluded.

`--notifications` fires after a provider turn and not after a slash command,
which answers immediately. A configured notification command that fails is
reported and the input loop continues; it cannot end the session.

`/copy` and `/paste` represent text-only clipboard effects. The adapter uses
`pbcopy`/`pbpaste`, `clip.exe`/PowerShell, `wl-copy`/`wl-paste`, or `xclip` when
available. These native utilities are not npm dependencies and missing commands
produce `ClipboardUnavailableError`. Image clipboard access and richer native
notification APIs remain optional, unsupported enhancements; they do not affect
the portable default installation.
