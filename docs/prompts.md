# Prompt resources and fences

Patch keeps prompts as typed modules under `src/resources/` so they compile into
the npm package and resolve independently of the current working directory.
Brand assets remain separate under `assets/`.

## Common resources

`COMMON_PROMPTS` is an exact TypeScript representation of the shared strings in
aider's
[`base_prompts.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_prompts.py#L1-L60).
The pinned compatibility fixture compares every field and newline, including
file-context instructions, repository-map boundaries, read-only guidance, and
post-edit status messages.

Format-specific production prompts are currently short Patch-authored
instructions, not complete pinned Aider prompt resources. `diff-fenced` reuses
the ordinary SEARCH/REPLACE prompt, and `udiff`/`patch` lack canonical examples
and reminders. Exact equality of `COMMON_PROMPTS` does not prove that the
concrete application consumes every field or formats each mode equivalently.

## Fence selection

`selectFence()` ports the ordered candidates and line-prefix collision check
from aider's
[`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L73-L84)
and
[`choose_fence`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L609-L629).
It prefers triple backticks, then quadruple backticks, then the `source`, `code`,
`pre`, `codeblock`, and `sourcecode` XML-style pairs. A candidate is skipped
when any source line begins with either its opening or closing marker. Indented
markers therefore do not collide, matching upstream.

If every candidate collides, selection reports `fellBack: true` and returns
triple backticks. The caller owns presentation of the corresponding warning.
Pinned fixtures cover the candidate order, backtick prefix behavior, indentation,
and exhausted fallback.

The selector itself matches the pinned candidate order. Production chooses a
fence from startup snapshots and reselects it from the files currently in
context whenever `/model` or `/chat-mode` switches the profile, and the selected
fence — not a literal triple backtick — wraps the read-only and editable file
messages, so prompt and parser agree on the same markers. Selection still
ignores the fallback warning and does not recompute when `/add`, `/drop`, or a
reflection changes the files in context between switches, so per-attempt fence
parity remains open.

## Message chunk order

`ChatChunks` validates and orders independently supplied sections as system,
examples, read-only files, repository map, completed history, editable files,
current turn, and reminder. That container-level order matches Aider.

The editable-files section is a user/assistant pair in all three upstream
shapes: file contents followed by `filesContentAssistantReply`;
`filesNoFullFilesWithRepoMap` and its reply when no file is editable but a
repository map is present; and `filesNoFullFiles` with `Ok.` otherwise.

Concrete prompt construction does not yet reproduce the remaining wrapper
dialogue: the read-only and repository-map sections still omit their Aider
assistant acknowledgements, examples lack the reset pair, and reminder
placement is unconditional. Prompt-cache marker placement is implemented at the
container level, but production map refresh is not stabilized for cache reuse.
