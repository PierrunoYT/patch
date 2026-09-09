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

Per-turn initialization, prompt composition, provider streaming, history
transitions, reflection, and cancellation remain separate Phase 3 tasks. Keeping
those concerns out of this first boundary makes strategy injection testable
without prematurely combining the conversation state machine with file writes.
