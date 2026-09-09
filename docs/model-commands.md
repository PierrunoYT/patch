# Model-suggested commands

Patch keeps shell commands parsed from model output inert until they cross the
`executeModelCommand` approval boundary. The boundary adapts aider's captured
execution behavior from
[`aider/run_cmd.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/run_cmd.py#L11-L132)
to cancellable Node.js child processes.

Before spawning, Patch presents the exact command and asks for approval for
that command. Denial has no process side effect. Approved commands run through
the platform shell with `cwd` set to the canonical repository root. Combined
captured stdout and stderr is capped at a configurable byte count while both
streams continue to be drained. A configurable timeout and an `AbortSignal`
terminate execution and return distinct `timed-out` or `cancelled` statuses.

`executeModelCommands` processes suggestions serially, applying the same
presentation and approval flow to each command, and stops after timeout or
cancellation. Lint and test execution reuses the bounded process behavior only
through `createConfiguredChecks`, which creates a check when the corresponding
user configuration is present. Patch deliberately does not select or guess a
package-manager command when `lint-cmd` or `test-cmd` is absent.
