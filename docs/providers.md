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

## Anthropic Messages

`AnthropicProvider` uses the official `@anthropic-ai/sdk` npm client. It moves
system messages into Anthropic's top-level `system` field, preserves ephemeral
cache-control markers on text blocks, and maps text, images, PDFs, tool results,
tool calls, thinking, usage, cached tokens, and stop reasons to the shared
contract. Constructor options support custom endpoints, timeout, headers, and
Fetch injection. Errors use the same provider-neutral classifications as the
OpenAI adapter.

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
| `deepseek` | OpenAI-compatible Chat Completions | yes | model-dependent | no | model-dependent |

`createProvider` is the live-provider construction boundary. It accepts only
the providers above, resolves their provider-specific credential names without
logging values, and throws `UnsupportedProviderError` for every other provider.
Custom base URLs remain available for compatible gateways; supporting a new
provider name requires an explicit adapter/table update and tests.

## Capability-aware context and continuation

`CoderSession` adds ephemeral prompt-cache boundaries only for models declaring
`promptCaching`. `keepPromptCacheAlive` performs a caller-scheduled, bounded
number of warming turns and stops on cancellation; it is a no-op for incapable
models. Models declaring `assistantPrefill` can continue up to three truncated
responses by sending accumulated output as the next assistant prefix.

`buildReadOnlyMediaMessage` labels image and PDF references and includes only
parts supported by the selected model. PDFs are always context-only and remain
subject to the Anthropic adapter's document support; OpenAI Chat Completions
continues to reject them at its boundary.
