# Coder session

`CoderSession` is the provider-neutral owner of one coding conversation. Its
boundary is adapted from aider's
[`Coder`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L88-L201),
but Patch composes behavior instead of requiring a subclass for every complete
mode.

The constructor injects a `ModelProvider` and an `EditStrategy` alongside a
validated session config, initial messages, editable/read-only paths, and fence.
The same session class can therefore use `ask`, whole-file, or SEARCH/REPLACE
behavior. Both initial state and every strategy result are runtime-validated,
and callers receive defensive state snapshots.

The initial implementation owns the model-output side of the edit pipeline:
parse through the injected strategy, resolve against immutable snapshots, and
stage a filesystem transaction. Staging never commits; explicit authorization
must occur before a caller invokes the returned transaction's `commit` method.

`prepareTurn` resets transient edit and usage state, composes typed prompt chunks
in upstream-compatible order, applies a conservative token estimate, and
returns a validated provider request. Over-budget prompts fail before a turn is
activated. `finalizeTurn` validates the complete response through the strategy
before atomically adding the user and assistant messages to durable history;
`abandonTurn` clears transient state without changing history.

The current token estimate is deliberately conservative and will be replaced
by model-aware counters where providers expose reliable tokenizers.

`runTurn` now consumes validated provider events, incrementally assembles text
and reasoning, reports each event to an optional observer, and records usage.
Classified retryable errors use bounded exponential backoff; context-window
errors bypass retries. Cancellation, missing finish events, and output-limit
truncation preserve diagnostic partial text but never append partial history or
stage edits. Successful responses alone pass through `finalizeTurn`.

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

`switch` atomically replaces the validated model, provider, and strategy while
retaining selected paths, usage, and compatible conversation state. The
strategy format must match the model. When formats differ, callers may inject a
history summarizer; without one, Patch removes old assistant protocol output
while retaining user intent so the replacement model does not imitate an
incompatible edit syntax.

## Architect/editor handoff

`ArchitectOrchestrator` runs a read-only architect session first and exposes its
complete plan to an injected acceptance callback. Only explicit acceptance can
start the separate editor session, whose model and edit protocol are
independently configured. Denial or an empty plan cannot consume an editor
turn, and a shared abort signal prevents the editor from starting after
cancellation.

## Context selection

`selectContextFiles` asks a dedicated read-only context session for the complete
set of files, repeats with the prior selection, and stops when the set is stable
regardless of response order. It defaults to three iterations and reports when
the bound, rather than convergence, ended selection. Cancellation is forwarded
to every provider turn and no filesystem state changes during selection.
