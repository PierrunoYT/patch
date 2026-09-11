# Edit strategies

Patch keeps model-output parsing behind the provider-neutral `EditStrategy`
contract. A strategy declares its format and converts one complete model
response plus the selected files and active fence into an `EditBatch`. Parsing
does not write to disk; authorization and application remain separate stages.

Current parity is uneven. Whole-file and basic SEARCH/REPLACE are the mature
paths. Unified-diff file transitions and Patch scopes/repeated actions are
implemented as described below; unified-diff marker/recovery behavior,
format-specific prompts, and broader pinned golden coverage remain incomplete.
Constructing a format is not a release-readiness or full parity claim.

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

`FencedSearchReplaceEditStrategy` has a separate `diff-fenced` identity and the
same parser as ordinary SEARCH/REPLACE, matching pinned
[`editblock_fenced_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_fenced_coder.py).
Its production system instruction, example, and reminder put the full filename
inside the active fence, immediately after the opening fence and language;
ordinary `diff` keeps the filename before the opening fence. Both examples
interpolate the fence selected from current file content. The prompts remain
short Patch-authored equivalents rather than byte-identical copies of the full
upstream prompt resources.

## Unified diff

`UnifiedDiffEditStrategy` parses git-style hunks inside `diff` fences and applies
exact unique context. Every `--- `/`+++ ` header transition closes the pending
hunk and switches the target path, so one fence can carry several files, and a
fence without a leading header continues the previously named file as upstream
does. A path keeps its `b/` prefix stripped only when the source header is `a/…`
or `/dev/null`; upstream applies that rule to a fence's first header pair alone,
and Patch intentionally applies it to every transition so later files resolve to
real repository paths.

The parser currently rejects standard `\ No newline at end of file` markers,
and before/after extraction appends a trailing newline. No-newline behavior
needs dedicated fixtures rather than a claim that tolerating the marker alone
would establish application parity. Aider's indentation, omitted-line,
partial-context, and duplicate-hunk recovery are not implemented, and identical
repeated hunks are not deduplicated.

## Patch actions

`PatchEditStrategy` parses typed `Add File`, `Delete File`, `Update File`, and
`Move to` actions with exact/trailing/surrounding-whitespace fuzz. A non-empty
`@@` scope anchor is located from the current position and moves the search
cursor past it, so a later occurrence of a repeated context can be targeted;
an unmatched scope is rejected. Upstream retries scope matching a second time
with identical stripped comparisons and one fuzz point; that pass can never
match where the first failed, so Patch compares once and adds no scope fuzz.

Actions are keyed by path with Aider's rules: repeated `Update File` blocks for
one path merge into a single edit, each block searching from the file's first
line; a second `Move to` target, an added path that already has an action, and a
delete combined with any other action are rejected. A repeated `Delete File` is
redundant rather than conflicting and is ignored. Merged update chunks are
applied to the original snapshot in line order, and overlapping or out-of-order
chunks are rejected instead of silently overwriting an earlier change.

`*** End of File` retains the upstream end preference/fuzz behavior. A move is
still expressed as a delete/create pair; the transaction writes the destination
before removing the source.

## Dry-run resolution

`resolveEditBatch` evaluates parsed edits against caller-supplied immutable file
snapshots. Generic replace edits to one file are resolved sequentially in an
isolated working map. Patch-strategy rewrites are already complete snapshots,
because that strategy merges every action for one path before emitting an edit.
Final results are classified as `create`, `update`, or `delete`. A move becomes a
delete/create pair; the commit phase, not the resolver, orders the destination
write before the source removal. The resolver performs no filesystem access or
writes.

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
and contained deletion. Every creation and update is written and synced before
any deletion runs, so a move keeps its source until the destination exists: an
interrupted move leaves both paths rather than neither. Each deletion is
revalidated against its resolved content immediately before the unlink, which
turns a case-only rename on a case-insensitive filesystem into a
`StaleFileSnapshotError` instead of a lost file.

This intentionally improves on aider's per-edit apply loop: parser, matcher,
stale-snapshot, containment, and encoding failures cannot leave a partial
multi-file update. Filesystem failures during the commit itself can still occur
between operations because portable filesystems do not provide an atomic
transaction spanning multiple paths; repository checkpoint/rollback belongs to
the later Git workflow.

## Property coverage

Property tests cover selected local invariants. Pinned fixtures cover a small
SEARCH/REPLACE sample and parsing one two-file unified-diff response, including
the intentional mid-block prefix difference. They do not establish complete
Aider parity for whole-file prompts, broader unified-diff application/recovery,
Patch scopes or repeated actions, provider requests beyond the concrete
`diff`/`diff-fenced` layout case, architect/context, or media. Each remaining
claim needs asymmetric exact-revision evidence at its production boundary.
