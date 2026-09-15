# Slash commands

Patch parses slash commands into runtime-validated effects before the concrete
application dispatches them through the same per-session queue as provider
turns. Effects operate on canonical application state rather than raw strings.
This ports the dispatch boundary from
[`aider/commands.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L30-L203)
without copying aider's stateful Python command object.

The parser recognizes `/add`, `/attach`, `/drop`, `/read-only`, `/help`,
`/settings`, `/report`, `/diff`, `/tokens`, `/map`, `/ls`, `/clear`, `/models`, `/model`,
`/chat-mode`, `/weak-model`, `/editor-model`, `/reasoning-effort`,
`/think-tokens`, `/run`, `/web`, `/test`, `/lint`, `/commit`, `/undo`, `/copy`,
`/paste`, and `/exit`.
Path commands support whitespace-separated paths and quoted paths. Commands
reject missing required arguments, unexpected arguments, unterminated quoting,
unknown chat modes, and unknown command names. Ordinary text is preserved in a
typed `submit` effect.

Path tokenization preserves backslashes before ordinary characters and a leading
UNC pair while supporting quoted spaces and POSIX escapes for whitespace,
quotes, and literal backslashes. `/add`, `/attach`, `/drop`, and `/read-only`
therefore share the same Windows-safe contract as configured editor commands.
Pinned aider's `!command` alias for `/run` and bare `/read-only` conversion of
every editable file are still unported. Patch sends a leading `!` as ordinary
model input and requires at least one `/read-only` path.

`/help` lists every supported command. `/help <query>` searches an explicit
allowlist of six Markdown documents installed with Patch and returns at most
eight matching lines, each limited to 240 characters and labeled with its
document and line number. Queries are limited to 256 control-free characters;
no match and missing-document states are reported without a provider fallback.
Unlike aider's model-backed semantic help, this command makes no provider call,
downloads no embeddings, uses no network, and does not add help text to chat
history. The packed executable test verifies search outside the source checkout.

`/models [query]` lists at most 50 configured canonical model names with only
their provider and edit format. The optional query is a bounded, control-free
literal substring and the command performs no provider or network request.
Aliases participate in matching but output resolves them to canonical names;
metadata, costs, endpoints, environment values, and credentials are never
rendered. Startup `--list-models [query]` uses the same renderer and works
without selecting a model or configuring provider credentials.

`/reasoning-effort [low|medium|high|off]` and `/think-tokens
[count|0]` inspect or update first-class request controls. A nonzero thinking
budget is 1,024 through 1,000,000 tokens and must remain below the model's
output limit. Updates rebuild and atomically install the active profile; `off`
or `0` removes the corresponding field. A model must explicitly declare the
matching capability, and Patch additionally confines reasoning effort to the
OpenAI adapter and thinking budgets to Anthropic. The bundled models declare
neither capability, so these controls are currently available only to a
strict custom catalog entry that opts in. Enabling either omits temperature.
Startup `--reasoning-effort` and `--thinking-tokens` use the same validation.

`/weak-model [name]` and `/editor-model [name]` inspect or replace secondary
roles without changing the active main model. Startup `--weak-model`,
`--editor-model`, and `--editor-edit-format` participate in normal staged
precedence. Role names resolve through the same strict catalog; editor formats
must have editor prompts. Role changes are serialized and assigned only after
resolution/validation. Summarization and generated commit messages use the
current weak role; accepted architect handoff uses the current editor role and
fresh editor history. Their provider usage continues into session accounting.

`/settings` shows the current model and chat mode (including successful
post-startup switches), encoding, enabled/disabled Git, hook verification and
generated commit messages, whether lint/test commands are configured, and
whether bootstrap corrected the repository root. These nine values are the
complete allowlist. The renderer cannot receive raw arguments, paths, command
text, commit identities, environment, provider headers/endpoints, model extras,
or credentials, and it never partially masks secrets. Display labels are bounded
and stripped of controls, format characters, and the U+2028/U+2029 separators,
so no label can end a line and forge a further settings row. `Git` reports
whether Git is actually in use rather than whether the flag was left on, since
running outside a repository leaves the flag set with no repository behind it. The command performs no provider request and its
packed-executable and secret-bearing interface tests cover terminal and history
output.

`/report [title]` prints a local issue draft for the user to review and copy. Its
complete metadata allowlist is the installed Patch version, Node.js version, OS
name and release, architecture, and Git version; missing or malformed values are
shown as unavailable. The optional title is limited to 160 characters without
controls or line separators, and is visibly labeled and JSON-quoted as
user-supplied text. The parser rejects a title that breaks those rules and the
renderer bounds one again, because it is exported and an embedding host may call
it directly. Paths,
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

`/diff` displays the current staged and unstaged Git diff for selected editable
files. It does not accept paths: selection remains the disclosure boundary, so
unselected and read-only changes are not shown. Git receives literal pathspecs,
including names with wildcard syntax, and both external diff drivers and
text-conversion filters are disabled so inspection cannot execute a
repository-configured helper. Inspection is ordered against Patch mutations on
the same worktree. The command strips terminal control and
bidirectional sequences, caps the complete UTF-8 response at 1 MiB without
splitting a code point, and marks truncation. It makes no provider call and asks
for no path, write, or command approval. Without Git integration it fails rather
than falling back to filesystem reads; with no selection or no selected changes
it reports that state explicitly. The packed executable test exercises a real
repository and proves an unselected change is absent.

Pinned aider's `/diff` compares commits recorded around the preceding message
and can display repository-wide committed changes. Patch does not maintain that
commit timeline and intentionally shows only current uncommitted selected-file
changes, preserving the same selected-diff privacy boundary used by commits and
generated commit messages.

`/tokens` rebuilds and counts the same system/examples, history, read-only file,
repository-map, editable-file, attachment, and reminder chunks used for a
production turn. It reports category estimates, the composed baseline total,
available input cost and context-window metadata, and whether counting used a
known OpenAI tokenizer or Patch's conservative fallback. The baseline excludes
the unknown next user message; that message can also change repository-map
ranking. Category estimates are counted independently and need not sum exactly
to the composed total because message-envelope overhead is applied to each
count. The output contains only fixed labels and bounded numeric/model metadata,
never prompt, file, map, history, media, environment, or credential content. It
makes no provider request and asks for no path, write, or process approval. This
differs from pinned aider mainly by naming estimate provenance and matching
Patch's own prompt chunk order rather than implying provider-native exactness.

`/map` displays the repository map currently available to the active model,
using the same fresh tracked/non-ignored inventory, selected-file exclusion,
ranking, token budget, and fallback sequence as production prompt construction.
It accepts no paths or query: the unknown next user message can personalize a
later turn's map differently. Models whose profile disables maps and
repositories with no available map report that state explicitly. Output is
terminal-sanitized and capped at 1 MiB without splitting UTF-8. The command
makes no provider request and invokes no path, write, or command approval.

Patch does not expose `/map-refresh`: `/map` and ordinary turns already rebuild
their view from fresh tracked/non-ignored inventory, while cache-policy controls
remain outside the command surface. `/copy-context` is a privacy non-goal because
it would copy raw prompt, history, file, map, and media context into an ambient
OS clipboard. `/tokens`, `/map`, and `/diff` retain bounded, purpose-specific
views instead.

File commands resolve paths through the repository containment boundary before
changing editable/read-only selections. A named path behaves as it always has:
it may not exist yet, and one that the repository ignores is reported rather
than silently dropped. It is not passed through path approval: the user named it
in the command they just typed, and containment and ignore rules still apply.

`/attach <path...>` is the media-only path command. It requires explicit approval
for every contained non-ignored file — the terminal supplies that approver, and
a session with no terminal has no way to answer, so `/attach` is refused there
rather than proceeding unapproved. Unlike `/add`, whose paths the user has just
typed, attaching sends the file's own bytes, which is what the prompt is for.
It validates PNG/JPEG/WebP/PDF content under fixed count and byte bounds, and
rejects media the current model cannot accept. Attachments are read-only request context, not chat history;
`/drop <path...>` removes them and `/drop` clears all attachments.

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

The `/copy` and `/paste` system utilities use a separate argv process boundary
with 10-second and 1-MiB defaults. It rejects oversized write input before spawn,
caps and drains read output, forwards the active session's `AbortSignal`, and
terminates the process tree on timeout, cancellation, or overflow. The direct
child's `close` event (after stdio closes) settles the operation, so a failed
utility releases the serialized session queue. Pinned aider's clipboard helper
is unbounded; this is intentional Patch hardening.

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
28 effects through `ConcreteApplicationService`: selections, media, history,
profile switching, local ancillary output, captured process/checks, bounded URL
content, clipboard, commit/owned undo, and exit. It also verifies safe failures for
missing clipboard and undo state, traversal, an unknown model, refused URL
ingestion, denied process execution, and submission after exit. No unsupported
named-command registration was found; the test makes future inventory drift fail.
It does not cover Windows backslash correctness, aider aliases/argument
semantics, or prose outside the extracted inventory. Clipboard bounds and queue
release have separate executable process and application-session tests.

## Parity limits

The advertised command set is completely dispatched but is not an aider-parity
surface:

- Model command breadth follows the model contracts rather than being added as
  aliases first. `/models`, `/think-tokens`, and `/reasoning-effort` now have
  their bounded underlying contracts. Weak/editor commands likewise resolve
  and switch independently through the catalog while keeping the main profile
  and history intact.

- `/model` and `/chat-mode` rebuild the whole model-derived profile — provider,
  parser, system prompt, examples, reminder, shell policy, fence, and
  repository-map policy — and install it only after the session accepts the
  switch, so a rejected or failed switch leaves the previous model active.
  Once the session has accepted the switch it is final: retiring the replaced
  provider happens afterwards, and a failure to close it is not reported as a
  failed switch and never tears down the provider now in use.
  `/chat-mode code` returns to the format of the model that is active now, not
  the startup model. An incompatible format switch first summarizes completed
  history through the current weak model, with bounded input, main-model
  fallback, and usage accounting. A summary or profile-construction failure
  leaves the old profile and history active; the replacement's capability
  filter then removes media it cannot accept.
- `/paste` submits clipboard text as a user turn. The text is used verbatim and
  is never reparsed as a command, so clipboard content the user did not write
  cannot dispatch `/run` or any other effect; an empty clipboard is rejected
  rather than submitted. Clipboard access is intentionally text-only: Patch
  does not probe for images or create out-of-repository temporary media. Save an
  image and use the visible, approved, contained `/attach <path...>` path.
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
`/copy` uses bounded, cancellable text-only platform utilities. `/exit` closes
the session and stops interactive input cleanly.
