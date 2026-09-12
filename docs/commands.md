# Slash commands

Patch parses slash commands into runtime-validated effects before the concrete
application dispatches them through the same per-session queue as provider
turns. Effects operate on canonical application state rather than raw strings.
This ports the dispatch boundary from
[`aider/commands.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L30-L203)
without copying aider's stateful Python command object.

The parser recognizes `/add`, `/drop`, `/read-only`, `/help`, `/settings`,
`/report`, `/ls`, `/clear`, `/model`, `/chat-mode`, `/run`, `/web`, `/test`,
`/lint`, `/commit`, `/undo`, `/copy`, `/paste`, and `/exit`.
Path commands support whitespace-separated paths and quoted paths. Commands
reject missing required arguments, unexpected arguments, unterminated quoting,
unknown chat modes, and unknown command names. Ordinary text is preserved in a
typed `submit` effect.

`/help` lists every supported command. `/help <query>` searches an explicit
allowlist of six Markdown documents installed with Patch and returns at most
eight matching lines, each limited to 240 characters and labeled with its
document and line number. Queries are limited to 256 control-free characters;
no match and missing-document states are reported without a provider fallback.
Unlike aider's model-backed semantic help, this command makes no provider call,
downloads no embeddings, uses no network, and does not add help text to chat
history. The packed executable test verifies search outside the source checkout.

`/settings` shows the current model and chat mode (including successful
post-startup switches), encoding, enabled/disabled Git, hook verification and
generated commit messages, whether lint/test commands are configured, and
whether bootstrap corrected the repository root. These nine values are the
complete allowlist. The renderer cannot receive raw arguments, paths, command
text, commit identities, environment, provider headers/endpoints, model extras,
or credentials, and it never partially masks secrets. Display labels are
control-free and bounded. The command performs no provider request and its
packed-executable and secret-bearing interface tests cover terminal and history
output.

`/report [title]` prints a local issue draft for the user to review and copy. Its
complete metadata allowlist is the installed Patch version, Node.js version, OS
name and release, architecture, and Git version; missing or malformed values are
shown as unavailable. The optional title is limited to 160 control-free
characters and is visibly labeled and JSON-quoted as user-supplied text. Paths,
chat, source, environment, credentials, and raw errors are not inputs to the
renderer. Unlike pinned aider's `report.py`, Patch never opens a browser or
constructs an upload or issue URL, and it makes no provider or network request.

The three ancillary commands use the same serialized application queue as turns
and other commands. Tests cover an active turn followed by `/help`, `/settings`,
and `/report` in exact order, cancellation both while report metadata is being
resolved and while a report waits in the queue, terminal sanitization, and no
calls to path, write, or process approval hooks. Package smoke dispatches all
three through the actual `patch` bin installed from `npm pack`; no fake provider
response or credential is needed.

File commands resolve paths through the repository containment boundary before
changing editable/read-only selections. A named path behaves as it always has:
it may not exist yet, and one that the repository ignores is reported rather
than silently dropped.

A directory selects the files beneath it and a glob selects the files it
matches. `*` and `?` stay inside one path segment, `**` crosses segments, `**/`
also matches no directory at all, and `[...]` is a character class. Expansion
walks the worktree from the pattern's fixed prefix, so it works with or without
Git. An exact existing file or directory is checked first, so metacharacters in
its name stay literal; only a missing exact path is interpreted as a pattern.
Expansion is contained on every side:

- symbolic links are skipped rather than followed, since a link is the one entry
  that can leave the resolved root or loop;
- `.git` is never descended into;
- ignored files are dropped from an expansion, and an expansion whose matches
  are all ignored says so instead of reporting an empty selection as success;
- an absolute glob is refused in favor of a repository-relative one;
- a selection over 200 files or a walk past 20,000 directory entries is refused
  by name, so `/add .` in a large worktree fails loudly instead of filling the
  context; and
- a pattern that matches nothing, or a directory with no files, is reported.

`/drop` expands the same way so it can undo an `/add` with the same words, but
it applies no ignore rules: whatever is selected can always be dropped.

`/run` uses the command preview/approval adapter and reports the command, how it
ended, both streams, and whether output was truncated — a command whose only
message went to stderr, or that was denied or timed out, is no longer
indistinguishable from one that said nothing. `/run --interactive` is described
in [rich terminal behavior](terminal.md). `/lint` and `/test` require explicit
configured commands; their output reaches the interface through the
`lint-complete`/`test-complete` events, so a failure states the outcome rather
than printing the same output twice. A model-suggested command reports through
`command-complete` as it finishes, so approving one and then seeing nothing is
no longer indistinguishable from a hang.

`/commit <message>` commits only selected editable paths with the supplied
message, without calling a provider. `/commit` alone uses the fixed default
unless `--generate-commit-messages` is enabled, in which case the active weak
model receives only the selected diff. All commit paths honor configured hook
verification and attribution. Generation failure leaves the index unchanged;
Git-hook failures may already have staged selected paths. See
[commit policy](git-repository.md#production-commit-policy) for limits and
explicit recovery.

## Model-suggested and configured commands

Shell commands parsed from model output remain inert until they cross the
`executeModelCommand` approval boundary. This adapts pinned
[`aider/run_cmd.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/run_cmd.py#L11-L132)
to cancellable Node.js child processes. Before spawning, the application shows
the exact command and requires approval for that command; without an approver,
it is denied. Denial has no process side effect.

Approved commands run through the platform shell with `cwd` set to the
canonical repository root. Combined captured stdout and stderr is capped at a
configurable byte count while both streams continue to be drained. A timeout
and an `AbortSignal` terminate execution and produce distinct `timed-out` or
`cancelled` statuses. These bounds are adapter options, not additional CLI
flags, and do not sandbox an approved command.

`executeModelCommands` processes suggestions serially and stops after timeout
or cancellation. Configured lint/test commands reuse the bounded executor:
the concrete application calls `executeModelCommand` under the worktree lock,
while `createConfiguredChecks` remains the callback adapter for embedding
callers. Only explicitly configured commands run; Patch never infers a
package-manager command when `lint-cmd` or `test-cmd` is absent. Configuring a
check authorizes its execution without a per-run prompt. See
[turn lifecycle](turn-lifecycle.md) for reflection ordering and failure behavior.

## Advertised-surface evidence

`tests/advertised-commands.test.ts` extracts the inventory at the top of this
document and requires exact set equality with `COMMAND_NAMES`, the parser and
completion source of truth. Its real temporary Git repository then executes all
19 effects through `ConcreteApplicationService`: selections, history, profile
switching, local ancillary output, captured process/checks, bounded URL content,
clipboard, commit/owned undo, and exit. It also verifies safe failures for
missing clipboard and undo state, traversal, an unknown model, refused URL
ingestion, denied process execution, and submission after exit. No unsupported
advertising was found; the test makes future documentation drift fail rather
than silently advertising an inert command.

## Parity limits

The advertised command set is completely dispatched but is not an aider-parity
surface:

- `/model` and `/chat-mode` rebuild the whole model-derived profile — provider,
  parser, system prompt, examples, reminder, shell policy, fence, and
  repository-map policy — and install it only after the session accepts the
  switch, so a rejected or failed switch leaves the previous model active.
  `/chat-mode code` returns to the format of the model that is active now, not
  the startup model. Switch-time history summarization is not supplied, so an
  incompatible switch drops assistant messages instead of summarizing them.
  This differs from automatic long-history compaction before ordinary turns,
  which is production-wired through the active model's weak model.
- `/paste` submits clipboard text as a user turn. The text is used verbatim and
  is never reparsed as a command, so clipboard content the user did not write
  cannot dispatch `/run` or any other effect; an empty clipboard is rejected
  rather than submitted. Clipboard images are still not read.
- `/web <url>` fetches one user-typed URL and adds its readable text to history,
  labeled with the URL redirects ended at and truncated to a share of the input
  window. A URL a model or a page mentions is never followed. See
  [URL fetching](url-fetching.md) for the SSRF, redirect, size, and
  no-subresource policy, which is an intentional difference from upstream.
- `/undo` reverts only the commit this session created, and only while it is
  still HEAD, still carries the Patch marker, has one parent, touches selected
  paths, and has not reached its upstream branch. A session undoes its latest
  commit once; earlier commits from the same session are not tracked.
- `/ls` and file-command matching are narrower than Aider. `/help` deliberately
  uses bounded literal line search over installed Patch docs instead of Aider's
  semantic model-backed help coder.

`/copy` uses text-only platform utilities. `/exit` closes the session and stops
interactive input cleanly.
