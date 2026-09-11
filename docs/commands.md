# Slash commands

Patch parses slash commands into runtime-validated effects before the concrete
application dispatches them through the same per-session queue as provider
turns. Effects operate on canonical application state rather than raw strings.
This ports the dispatch boundary from
[`aider/commands.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L30-L203)
without copying aider's stateful Python command object.

The parser recognizes `/add`, `/drop`, `/read-only`, `/ls`, `/clear`, `/model`,
`/chat-mode`, `/run`, `/web`, `/test`, `/lint`, `/commit`, `/undo`, `/copy`,
`/paste`, and `/exit`.
Path commands support whitespace-separated paths and quoted paths. Commands
reject missing required arguments, unexpected arguments, unterminated quoting,
unknown chat modes, and unknown command names. Ordinary text is preserved in a
typed `submit` effect.

File commands resolve paths through the repository containment boundary before
changing editable/read-only selections. A named path behaves as it always has:
it may not exist yet, and one that the repository ignores is reported rather
than silently dropped.

A directory selects the files beneath it and a glob selects the files it
matches. `*` and `?` stay inside one path segment, `**` crosses segments, `**/`
also matches no directory at all, and `[...]` is a character class. Expansion
walks the worktree from the pattern's fixed prefix, so it works with or without
Git, and it is contained on every side:

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

The advertised command set is not yet a completed parity surface:

- `/model` and `/chat-mode` rebuild the whole model-derived profile — provider,
  parser, system prompt, examples, reminder, shell policy, fence, and
  repository-map policy — and install it only after the session accepts the
  switch, so a rejected or failed switch leaves the previous model active.
  `/chat-mode code` returns to the format of the model that is active now, not
  the startup model. Automatic history summarization is still absent, so an
  incompatible switch drops assistant messages instead of summarizing them.
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
- `/ls` and file-command matching are narrower than Aider, and semantic command
  help is absent.

`/copy` uses text-only platform utilities. `/exit` closes the session and stops
interactive input cleanly.
