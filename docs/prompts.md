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

Format-specific instructions are intentionally not loaded into this common
resource. Each edit strategy will own its corresponding prompts when that
strategy is implemented, preventing instructions for unsupported or inactive
formats from leaking into a session.

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

## Message chunk order

`ChatChunks` keeps each independently generated prompt section separate until a
provider request is assembled. It validates system, user, assistant, and tool
roles, then emits the upstream order: system, examples, read-only files,
repository map, completed history, editable files, current turn, and reminder.
Omitted sections default to empty arrays.

Prompt caching marks the final text message in three stable sections: examples
(or system when there are no examples), repository map (or read-only files when
there is no map), and editable files. The operation returns new chunks rather
than mutating session history. Provider adapters translate Patch's normalized
`cacheControl` field to provider-specific request syntax.
