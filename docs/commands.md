# Slash commands

Patch parses slash commands into runtime-validated effects before the concrete
application dispatches them through the same per-session queue as provider
turns. Effects operate on canonical application state rather than raw strings.
This ports the dispatch boundary from
[`aider/commands.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L30-L203)
without copying aider's stateful Python command object.

The parser recognizes `/add`, `/drop`, `/read-only`, `/ls`, `/clear`, `/model`,
`/chat-mode`, `/run`, `/test`, `/lint`, `/commit`, `/undo`, `/copy`, `/paste`,
and `/exit`.
Path commands support whitespace-separated paths and quoted paths. Commands
reject missing required arguments, unexpected arguments, unterminated quoting,
unknown chat modes, and unknown command names. Ordinary text is preserved in a
typed `submit` effect.

File commands resolve literal paths through the repository containment boundary
before changing editable/read-only selections; directory/glob expansion is not
implemented. `/run` uses the command preview/approval adapter; `/lint` and
`/test` require explicit configured commands.

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
- `/undo` reverts only the commit this session created, and only while it is
  still HEAD, still carries the Patch marker, has one parent, touches selected
  paths, and has not reached its upstream branch. A session undoes its latest
  commit once; earlier commits from the same session are not tracked.
- `/ls` and file-command matching are narrower than Aider, and semantic command
  help is absent.

`/copy` uses text-only platform utilities. `/exit` closes the session and stops
interactive input cleanly.
