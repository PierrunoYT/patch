# Model providers

Production support is partial. OpenAI and Anthropic have basic executable
streaming routes, and the DeepSeek endpoint's model name, output limit, and
assistant-prefill request are normalized through the same factory path the
executable uses. Metadata merging, temperature policy, and broader transient
error classification remain incomplete. Provider breadth is intentionally
narrower than Aider's LiteLLM surface.

## DeepSeek dialect

`OpenAIProvider` takes a `dialect` of `openai` or `deepseek`; `createProvider`
selects `deepseek` for models whose provider is `deepseek`. The dialect changes
three things, because DeepSeek accepts the Chat Completions shape but not all of
OpenAI's spellings:

- The `deepseek/` routing prefix LiteLLM uses in catalog names is stripped, so
  the bundled `deepseek/deepseek-chat` is sent as `deepseek-chat`.
- The output limit is sent as `max_tokens` rather than `max_completion_tokens`.
- A trailing assistant message — the continuation prefill a length-truncated
  turn produces — is marked `prefix: true` and sent to the endpoint's `/beta`
  path, which is the only path that continues it. Turns without a trailing
  assistant message stay on the standard path.

On an OpenAI endpoint none of these apply: the model name, `max_completion_tokens`,
and a trailing assistant message are all passed through unchanged.

## OpenAI-compatible Chat Completions

`OpenAIProvider` uses the official `openai` npm client and accepts an API key,
custom base URL, timeout, organization/project identifiers, default headers,
and an injected Fetch implementation. Per-request `extraParameters` are passed
through while Patch retains control of the model, messages, streaming mode, and
output limit.

The adapter validates streamed chunks and maps text, reasoning, fragmented tool
calls, token usage, cached input tokens, and finish reasons into Patch's common
provider events. Tool calls are transport events only: `CoderSession` does not
declare tools or assemble tool-call results. Authentication, rate-limit,
timeout, network, and context errors have focused classifications; SDK 5xx and
response-validation failures still fall through as non-retryable provider
errors. PDF message parts are rejected because Chat Completions does not define
a portable PDF representation. `CoderSession` drains the stream past `finish`,
so the usage chunk these endpoints send after the finish reason is accounted;
rendering usage and cost at the terminal boundary is still incomplete.

Default tests use mocked Fetch responses and never require credentials or
network access.

## Opt-in live contracts

`tests/live-provider.test.ts` is skipped unless `PATCH_LIVE_PROVIDERS=1`. Each
OpenAI, Anthropic, or DeepSeek case also skips when its provider-specific key is
absent. The protected, manually dispatched `live-providers.yml` workflow has a
five-minute job bound and sends one tiny response request per configured
provider; it never runs for pull requests. Model overrides use
`PATCH_LIVE_OPENAI_MODEL`, `PATCH_LIVE_ANTHROPIC_MODEL`, and
`PATCH_LIVE_DEEPSEEK_MODEL`.

Live contracts assert text streaming, usage, and finish events; Anthropic also
exercises a cache-control system block. Authentication classification,
cancellation, timeout, fragmented events, and secret-safe diagnostics remain
deterministic mocked-adapter tests because intentionally failing live calls are
variable and wasteful. Provider availability, account permissions, model names,
rate limits, and API behavior can make a manual live run fail independently of
the credential-free suite. Tests and workflow configuration never print key
values.

The DeepSeek live case constructs the adapter directly with endpoint-facing
`deepseek-chat`. The bundled catalog name `deepseek/deepseek-chat` now reaches
the same request shape through `createProvider`, covered without credentials by
`tests/deepseek-provider.test.ts`; the live case still does not exercise the
alias/catalog/session path end to end.

## Anthropic Messages

`AnthropicProvider` uses the official `@anthropic-ai/sdk` npm client. It moves
system messages into Anthropic's top-level `system` field, preserves ephemeral
cache-control markers on text blocks, and maps text, images, PDFs, tool results,
tool calls, thinking, usage, cached tokens, and stop reasons to the shared
contract. Constructor options support custom endpoints, timeout, headers, and
Fetch injection. Basic message/event mapping uses the shared contract, but this
does not imply identical retry classification for every SDK error.

## Preflight diagnostics

`diagnoseProvider` checks provider-specific credential names and requested
capabilities before constructing a live workflow. It accepts an explicit
environment snapshot or a `credentialPresent` flag; it never reads or returns a
secret value. Capability errors distinguish a model that does not declare a
feature from an adapter that cannot represent it. `assertProviderReady` turns
the structured result into `ProviderConfigurationError` for startup paths.

## Compatibility

| Model provider | Adapter | Streaming | Images | PDFs | Prompt cache markers |
| --- | --- | --- | --- | --- | --- |
| `openai` | OpenAI Chat Completions | yes | yes | no | no |
| `anthropic` | Anthropic Messages | yes | yes | yes | yes |
| `deepseek` | OpenAI-compatible Chat Completions, `deepseek` dialect | yes | model-dependent | no | no explicit markers |

`createProvider` is the executable construction boundary. It accepts only the
providers above, resolves their provider-specific credential names without
logging values, and throws `UnsupportedProviderError` for every other provider.
Custom base URLs and timeouts are constructor/factory options for embedding
callers; the executable bootstrap does not expose them.

## Capability-aware context and continuation

`CoderSession` adds ephemeral prompt-cache boundaries only for models declaring
`promptCaching`. `keepPromptCacheAlive` is a caller-scheduled library helper.
Models declaring `assistantPrefill` enter a bounded continuation path in
production, but Patch currently sends an ordinary assistant message rather than
Aider's provider prefix field and accumulates duplicate prefixes after repeated
truncation. It is not complete provider-wire parity.

`buildReadOnlyMediaMessage` labels image and PDF references and includes only
parts supported by the selected model. PDFs are always context-only and remain
subject to the Anthropic adapter's document support; OpenAI Chat Completions
continues to reject them at its boundary.
