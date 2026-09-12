# Coder session

`CoderSession` is the provider-neutral owner of one coding conversation. Its
boundary is adapted from aider's
[`Coder`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L88-L201),
but Patch composes behavior instead of requiring a subclass for every complete
mode.

`ConcreteApplicationService` is the production composition owner around this
contract. It loads catalog records, constructs the main provider and one
supported strategy, canonicalizes selected files, rebuilds selected snapshots
and repository-map context for each turn, and serializes callers per session.
Catalog metadata is merged into executable settings, tracked inventory is
refreshed per turn with a startup-inventory fallback on status failure, and
sessions sharing a resolved worktree use one in-process mutation lock. Separate
processes are not serialized by that lock. The composed modes are `ask`, `whole`,
`diff`, `diff-fenced`, `udiff`, and `patch`; constructed parsers do not establish
complete prompt, recovery, or fixture parity. See [edit strategies](edit-strategies.md).

The constructor injects a `ModelProvider` and an `EditStrategy` alongside a
validated session config, initial messages, editable/read-only paths, and fence.
The same session class can therefore use `ask`, whole-file, or SEARCH/REPLACE
behavior. Both initial state and every strategy result are runtime-validated,
and callers receive defensive state snapshots.

The initial implementation owns the model-output side of the edit pipeline:
parse through the injected strategy, resolve against immutable snapshots, and
stage a filesystem transaction. Staging never commits; explicit authorization
must occur before a caller invokes the returned transaction's `commit` method.

The concrete application now owns the post-response lifecycle. It resolves and
stages the complete batch, emits a preview, authorizes new or out-of-chat paths,
checkpoints dirty selected files, applies and commits only selected paths, runs
configured lint against edited disk content, approves suggested commands one
at a time, then runs configured tests. Ordinary literal selected-path
commits exclude unrelated work, and Git path arguments are literal so wildcard
or bracket names cannot expand at that boundary. Commit-failure index
restoration remains unresolved. A successful application records the final
marker-bearing commit and returns the session to `waiting`.

For composed turns, `CoderSession` deep-clones and freezes the application
attempt context before constructing the provider request. The resulting
candidate carries that same prompt, file snapshots, and editable/read-only sets
to the application lifecycle callback. Reflection obtains a new context;
transport retries retain the same one. Parsing and authorization therefore
cannot accidentally observe a later mutable session snapshot.

Multi-file writes are not transactionally rolled back after the first rename.
Patch validates every snapshot and dry-runs every operation before the first
mutation, and Git-enabled sessions create a checkpoint for dirty selected files,
but a filesystem failure during the commit loop may leave an already-written
prefix on disk. The error is reported and the valid files are left for explicit
user recovery; Patch does not claim atomic multi-file rollback.

`prepareTurn` resets transient edit and per-turn token counters, composes typed
prompt chunks in the container-level upstream order, and applies model-aware
OpenAI text counting with a conservative fallback for other/multimodal prompts.
It does not clear a prior `lastUsage`, and concrete wrapper messages/reminder
policy are not full Aider prompt parity. Over-budget prompts fail before a turn
is activated. `finalizeTurn` validates the complete response through the
strategy before adding user/assistant messages; `abandonTurn` clears transient
state without changing history.

`runTurn` now consumes validated provider events, incrementally assembles text
and reasoning, reports each event to an optional observer, and records usage.
The stream is drained past the finish event because OpenAI-compatible endpoints
deliver final usage in a later chunk; after finish only usage is still
accounted, so nothing can extend or invalidate a completed response.

Completed history is summarized automatically. Before each turn, if history
exceeds the active model's `maxChatHistoryTokens` (1024 by default, as
upstream), `summarizeHistory` replaces it. `ChatSummary` ports aider's algorithm:
the most recent half-budget of messages is kept verbatim, the head is split at an
assistant message and sent for summarization, and the result recurses up to three
times before summarizing everything at once. The summary always ends on an
assistant message so the next turn's user message is not the second in a row.
The concrete application summarizes with the active model's weak model, resolved
at call time so `/model` changes it too. A summarizer that fails leaves history
untouched and the turn proceeds — losing a summary is recoverable, and an
oversized prompt still fails on the explicit token-budget check.

A model whose settings carry a `reasoningTag` reasons inside the ordinary
content stream instead of a separate one. `ReasoningTagSplitter` divides those
deltas as they arrive — holding back only text that could still begin the tag,
so a tag broken across deltas is still recognized — and the tagged span is
re-emitted as `reasoning-delta`. Display, history, and the edit parser therefore
all see the answer alone. A closing tag with no opening tag means reasoning
began before the first delta, which streaming cannot detect in time to keep off
the screen; the finished response is checked once more with
`removeReasoningContent` so history and parsing are still clean, matching
upstream. `deepseek/deepseek-reasoner`, aliased `r1`, is the bundled model that
uses this.
Classified retryable errors use bounded exponential backoff; context-window
errors bypass retries. Cancellation, missing finish events, and output-limit
truncation preserve diagnostic partial text and do not parse or stage that
incomplete response. If earlier attempts already mutated the worktree, history
retains the exchanges associated with the surviving work; a turn with no
mutation leaves history unchanged on failure. See [turn recovery](turn-lifecycle.md).

Malformed strategy output automatically produces a corrective reflection turn.
Callers can inject lint and test checks that return diagnostics, allowing the
same loop to repair failures without letting the session guess or execute
commands. Lint runs before tests and a lint failure skips that round's tests.
`createConfiguredChecks` provides the process adapter for this injection. It
creates callbacks only for explicit `lint-cmd` and `test-cmd` values, runs them
at the canonical repository root with bounded output and cancellation, and
returns nonzero output to the reflection loop. It never infers commands from a
target repository's package-manager files.
The initial attempt may be followed by at most `maxReflections` corrections
(three by default); exhaustion raises `ReflectionLimitError`. Failed responses
and diagnostics are sent to the provider and retained in successful history.

Repository-relative paths mentioned by the user are detected from an explicit
candidate list. They join the editable set only when the injected approval
callback accepts each path. Parsed model edits receive the same check before
checks, staging, or writes; an unselected/new path is rejected when approval is
absent or denied, and read-only paths remain non-editable.

`switch` atomically replaces `CoderSession`'s model, provider, parser strategy,
and fence: every argument is validated, and history is rebuilt, before any field
is assigned, so a rejected switch leaves the session untouched. History is made
compatible with the replacement model in two steps — assistant output in the
previous protocol is dropped when the edit format changes, and image or document
parts are dropped whenever the replacement model lacks that capability, since
history outlives the model that produced it.

The concrete application rebuilds the rest of the model-derived state in the
same operation. A `SessionProfile` holds the active main model, the format
`/chat-mode code` returns to, the strategy definition (system prompt, examples,
reminder, shell policy), the fence reselected from the files currently in
context, and the repository map required by the new model's `useRepoMap`. The
profile is replaced only after `switch` succeeds, so a failed provider
construction or a rejected switch cannot leave prompts describing a model that
is no longer active. Production supplies no switch-time history summarizer, so
an incompatible switch drops assistant messages rather than summarizing them.
The automatic long-history compaction described above is a separate,
production-wired path.

## Architect/editor handoff

`ArchitectOrchestrator` runs a read-only architect session first and exposes its
complete plan to an injected acceptance callback. Only explicit acceptance can
start the separate editor session, whose model and edit protocol are
independently configured. Denial or an empty plan cannot consume an editor
turn, and a shared abort signal prevents the editor from starting after
cancellation.

This orchestrator is an exported helper, not a mode constructed by
`ConcreteApplicationService`. It does not establish selected-file/context,
commit, cost, or final-history transfer parity.

## Context selection

`selectContextFiles` asks a dedicated read-only context session for the complete
set of files, repeats with the prior selection, and stops when the set is stable
regardless of response order. It defaults to three iterations and reports when
the bound, rather than convergence, ended selection. Cancellation is forwarded
to every provider turn and no filesystem state changes during selection.

This selection loop is also helper-only. It does not replace the concrete
session's selected paths or force/rebuild repository-map context between
iterations.
