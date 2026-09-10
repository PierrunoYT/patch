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

- `/model` and `/chat-mode` replace provider/parser state but retain the
  startup prompt definition, shell policy, fence, map policy, and some model
  defaults for the next turn.
- `/paste` reads and displays clipboard text as an application response instead
  of submitting it as a user turn.
- `/undo` accepts a marker-bearing HEAD but is not yet bound to the current
  session's owned commit.
- `/ls` and file-command matching are narrower than Aider, and semantic command
  help is absent.

`/copy` uses text-only platform utilities. `/exit` closes the session and stops
interactive input cleanly.
