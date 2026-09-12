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

`strategy-prompts.ts` ports the format-specific resources for the six
constructed modes from the pinned ask, whole-file, edit-block, fenced
edit-block, unified-diff, Patch, and shell prompt modules. Their production
system instructions, examples, reminders, and shell policy interpolate the
active fence. `diff-fenced` puts the filename after the opening fence and
language; ordinary `diff` puts it before the fence. Patch intentionally uses
English, requires explicit approval for every suggested command and
out-of-chat path, and tells models about its safer unique-match/transactional
rules rather than promising aider's first-match behavior.

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

The selector itself matches the pinned candidate order. Before every initial or
reflected provider attempt, production re-reads the selected files, chooses one
fence, reconstructs the strategy resource, wraps read-only/editable content,
and updates the parser with that same fence. `/add`, `/drop`, successful edits,
and external content changes therefore cannot leave stale prompt fencing.
Selection still ignores the exhausted-candidate warning and falls back to
triple backticks, matching the existing documented limitation.

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
