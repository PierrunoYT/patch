# Input modes

Patch's input sequencing is adapted from
[`aider/main.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py)
and
[`aider/io.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py),
modified for asynchronous Node.js streams.

- `patch --message "..."` submits exactly one message and exits.
- `patch --message-file path` reads the complete UTF-8 file, submits it once,
  and exits.
- With neither option, Patch reads non-empty terminal lines serially until EOF.
- The two one-shot options are mutually exclusive.

Input acquisition calls an injected message handler. This keeps terminal and
file I/O independent from session/provider construction and lets default tests
run without credentials. Until a real provider is configured, attempting to
submit a message reports that no provider is configured.
