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

Provider streaming, retries, reflection, and cancellation remain separate
Phase 3 tasks. The current token estimate is deliberately conservative and will
be replaced by model-aware counters where providers expose reliable tokenizers.
