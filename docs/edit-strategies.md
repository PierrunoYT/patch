# Edit strategies

Patch keeps model-output parsing behind the provider-neutral `EditStrategy`
contract. A strategy declares its format and converts one complete model
response plus the selected files and active fence into an `EditBatch`. Parsing
does not write to disk; authorization and application remain separate stages.

## Ask

`AskEditStrategy` ports aider's
[`AskCoder`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/ask_coder.py)
and the inherited no-op edit behavior in
[`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2425-L2432).
It always returns an empty edit batch, even when a response contains text that
resembles file or shell blocks. Its system prompt asks for analysis and avoids
claims that files were changed.

## Whole file

`WholeFileEditStrategy` ports aider's
[`WholeFileCoder.get_edits`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/wholefile_coder.py#L26-L128).
It parses complete fenced file bodies into `rewrite` edits. A filename can come
from the line before a fence, a prior backtick-quoted editable-file mention, or
the sole editable file. Explicit names outrank mention and single-file
inference, common `path/to/` prefixes for root-level files are corrected, and
duplicate rewrites keep the most reliable block.

The parser preserves the model's trailing-newline choice, accepts an unclosed
final block like upstream, supports both symmetric backtick and distinct XML
fences, and rejects unnamed blocks when more than one file is eligible. It only
returns proposed rewrites and performs no filesystem access.

## SEARCH/REPLACE

`SearchReplaceEditStrategy` and `applySearchReplace` port the parser and active
replacement paths from
[`editblock_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_coder.py#L15-L217).
The parser recognizes five-to-nine-character SEARCH markers, carries filenames
between consecutive blocks, separates common shell fences, and returns proposed
`replace` edits without reading or writing files. Malformed blocks include the
parsed response prefix and expected marker in their error.

The pure replacement function tries exact lines, uniform leading-whitespace
normalization, a spurious leading blank line, and paired `...` elision in that
order. It matches the pinned upstream fixture for each successful mode and
adds one intentional safety rule: a SEARCH section matching multiple locations
is rejected instead of silently changing the first one. Missing and ambiguous
matches have distinct errors suitable for a later reflection loop.

`FencedSearchReplaceEditStrategy` is the pinned upstream `diff-fenced` prompt
variant. It intentionally reuses the SEARCH/REPLACE wire parser and matcher but
has an independent format identity and reminder requiring every block to be
inside the active fence. This lets format switches discard incompatible
examples without duplicating edit semantics.

## Dry-run resolution

`resolveEditBatch` evaluates a complete parsed batch against caller-supplied
immutable file snapshots. Edits to the same file are resolved sequentially in
an isolated working map. Final results are classified as explicit `create`,
`update`, or `delete` operations; updates and deletes retain the original
content for later stale-snapshot checks or rollback. Moves become a delete and
create pair. The resolver performs no filesystem access or writes, so a
parse or replacement failure cannot leave a partially applied batch.

Every model-selected path must have an explicit snapshot, including a `null`
snapshot for a confirmed missing path. This keeps safe path lookup and approval
decisions at the caller boundary. Errors identify the failing edit index and
path while preserving the underlying matching failure as their cause. A series
of edits that returns a file to its original state emits no operation, and
shell suggestions are copied without execution.

## Transactional staging

`EditTransaction.stage` validates every resolved operation against the current
safe filesystem before authorization or mutation. It checks containment,
missing/existing state, exact original content, encoding, and write shape using
the filesystem adapter's dry-run methods. Staging does not create parent
directories or alter files. Suggested shell commands remain inert metadata.

After the caller obtains explicit user authorization, `commit` revalidates the
entire batch before its first mutation, then uses atomic per-file replacement
and contained deletion. This intentionally improves on aider's per-edit apply
loop: parser, matcher, stale-snapshot, containment, and encoding failures cannot
leave a partial multi-file update. Filesystem failures during the commit itself
can still occur between operations because portable filesystems do not provide
an atomic transaction spanning multiple paths; repository checkpoint/rollback
belongs to the later Git workflow.

## Property coverage

The edit engines are property-tested with generated asymmetric Unicode text,
CRLF blocks, repeated matches, empty-file appends, valid and invalid marker
lengths, duplicate whole-file names, and traversal paths. These properties
assert content equality and specific rejection classes rather than merely
checking that parsers do not crash. Fixed pinned-upstream fixtures remain the
compatibility oracle for exact, indentation-normalized, and elided replacements.
