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

File commands resolve through the repository containment boundary before
changing editable/read-only selections. Model and mode commands reconstruct a
matching provider/strategy pair and preserve compatible history. `/run` always
uses the command preview/approval adapter; `/lint` and `/test` require explicit
configured commands. Git commands include only currently editable paths, and
undo accepts only a marker-bearing Patch commit whose paths remain selected.
Clipboard commands use text-only platform utilities and report their focused
unavailable-platform error. `/exit` closes the session and stops interactive
input cleanly.
