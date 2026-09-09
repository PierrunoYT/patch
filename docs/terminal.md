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
