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
