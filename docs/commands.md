# Slash commands

Patch parses slash commands into inert, runtime-validated effects before a
session controller performs any filesystem, model, Git, or process operation.
This ports the dispatch boundary from
[`aider/commands.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L30-L203)
without copying aider's stateful Python command object.

The parser recognizes `/add`, `/drop`, `/read-only`, `/ls`, `/clear`, `/model`,
`/chat-mode`, `/run`, `/test`, `/lint`, `/commit`, `/undo`, and `/exit`.
Path commands support whitespace-separated paths and quoted paths. Commands
reject missing required arguments, unexpected arguments, unterminated quoting,
unknown chat modes, and unknown command names. Ordinary text is preserved in a
typed `submit` effect.

`/run` carries the exact command text but does not execute it. `/test` and
`/lint` carry no arbitrary command argument; a later execution boundary must
resolve only explicitly configured commands. Effects similarly leave path
containment, authorization, model construction, commits, and undo to their
owning adapters.
