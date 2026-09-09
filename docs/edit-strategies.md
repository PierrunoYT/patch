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
