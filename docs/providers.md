# Model providers

## OpenAI-compatible Chat Completions

`OpenAIProvider` uses the official `openai` npm client and accepts an API key,
custom base URL, timeout, organization/project identifiers, default headers,
and an injected Fetch implementation. Per-request `extraParameters` are passed
through while Patch retains control of the model, messages, streaming mode, and
output limit.

The adapter validates streamed chunks and maps text, reasoning, fragmented tool
calls, token usage, cached input tokens, and finish reasons into Patch's common
provider events. Authentication, rate-limit, timeout, network, and context
errors are classified for the session retry policy. PDF message parts are
rejected because Chat Completions does not define a portable PDF representation.

Default tests use mocked Fetch responses and never require credentials or
network access.
