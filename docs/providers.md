# Model providers

Production support is partial. OpenAI and Anthropic have basic executable
streaming routes, and the DeepSeek endpoint's model name, output limit, and
assistant-prefill request are normalized through the same factory path the
executable uses. Catalog metadata is merged into model settings, a temperature
policy decides what each request carries, transient failures are classified by
HTTP status, and the terminal reports tokens and available cost after each turn. Missing bundled
prices render as unknown rather than zero, and cache reads and cache writes are
priced apart from ordinary input tokens against one cross-provider usage
contract. See [model catalog](model-catalog.md#usage-and-cost). Provider
breadth is intentionally narrower than Aider's LiteLLM surface.

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
declare tools or assemble tool-call results. PDF message parts are rejected
because Chat Completions does not define
a portable PDF representation. `CoderSession` drains the stream past `finish`,
so the usage chunk these endpoints send after the finish reason is accounted and
reaches the terminal's per-turn token and cost line.

## Error classification

Both adapters classify an SDK error the same way, because the retry decision
belongs to the failure and not to the vendor. Their own error classes cover
authentication, rate limits, timeouts, and connection loss; `transientByStatus`
then covers what those classes miss, keyed on HTTP status rather than a table of
exception classes: 408 as a timeout, 429 as a rate limit, and 409 or any 5xx —
internal, bad gateway, service unavailable, and the 529 overload some providers
return — as a retryable provider failure. A request the server rejected as
malformed, such as a 400, stays non-retryable, because repeating it produces the
same rejection. A chunk that fails schema validation is reported as a retryable
provider error rather than failing the turn, since a truncated or garbled
response is far more likely than a permanent contract change. Context-window
errors are matched by message and bypass retries.

`CoderSession` owns the retry loop with bounded exponential backoff; the SDK
clients are constructed with `maxRetries: 0` so attempts are not multiplied.
The adapters parse only `retry-after-ms` or standard `Retry-After` seconds/HTTP
dates from an SDK error. The resulting millisecond value is capped at 60 seconds;
malformed and negative values are ignored, and no other response header is
retained. The session waits for the greater of that value and its local backoff,
subject to its own configured cap. Retry configuration permits at most ten
attempts, defaults to three, and uses an abort-aware timer. Aider's pinned loop
does not inspect `Retry-After` and blocks during sleep; Patch intentionally adds
bounded header support and responsive cancellation.

All production adapter errors use fixed messages by category. Raw SDK/server
messages can reflect credentials, custom headers, private endpoints, prompts, or
response fragments, so they are used only internally for classification and do
not enter completion events or conversation history. Malformed stream events
likewise emit a fixed message without schema values.

## Lifetime ownership

The concrete service owns the startup provider. Each application session owns
providers created by `/model` or `/chat-mode`: a successful replacement closes
the prior session-owned provider, a failed switch closes the unused candidate,
and session shutdown aborts its stream, drains its queue, then closes its active
session-owned provider. Temporary weak-model providers used for summarization or
commit subjects close in `finally`; a shared/current provider is never closed by
temporary-use cleanup. Service shutdown closes all sessions concurrently and
then the startup provider, attempting every close even when one fails.

Provider construction is the last composition-root step, so earlier startup
failures cannot leak a client. This explicit ownership is Patch lifecycle
hardening: pinned Aider relies on process/object lifetime and does not provide a
corresponding async provider-close contract.

Default tests use mocked Fetch responses and never require credentials or
network access.

## Opt-in live contracts

`tests/live-provider.test.ts` gates providers independently with
`PATCH_LIVE_OPENAI=1`, `PATCH_LIVE_ANTHROPIC=1`, and
`PATCH_LIVE_DEEPSEEK=1`. Each case also skips when its provider-specific key is
absent. The protected, manually dispatched `live-providers.yml` workflow has a
five-minute job bound and never runs for pull requests. Model overrides use
`PATCH_LIVE_OPENAI_MODEL`, `PATCH_LIVE_ANTHROPIC_MODEL`, and
`PATCH_LIVE_DEEPSEEK_MODEL`.

The OpenAI and Anthropic contracts each assert text streaming, positive usage,
a natural stop reason, SDK timeout, pre-aborted cancellation, and secret-safe
missing-credential diagnostics. OpenAI's successful request includes a tiny PNG;
Anthropic's includes an ephemeral cache-control system block. Deterministic
adapter tests repeat timeout, cancellation, authentication rejection, fragmented
events, and diagnostic secrecy without network access. Provider availability,
account permissions, model names, rate limits, and API behavior can make a
manual live run fail independently of the credential-free suite. Tests and
workflow configuration never print key values, custom headers, endpoint URLs,
or media bytes.

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
Fetch injection. Message and event mapping and the transient-failure
classification above are both shared with the OpenAI-compatible adapter; only
the SDK error classes and the context-window message pattern differ.

## Preflight diagnostics

`diagnoseProvider` checks provider-specific credential names and requested
capabilities before constructing a live workflow. It accepts an explicit
environment snapshot or a `credentialPresent` flag; it never reads or returns a
secret value. Capability errors distinguish a model that does not declare a
feature from an adapter that cannot represent it. `assertProviderReady` turns
the structured result into `ProviderConfigurationError` for startup paths.
Authentication rejection events use a fixed provider-specific message rather
than the SDK/server message, so reflected credentials, headers, and endpoints
cannot enter diagnostics.

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
`promptCaching`. A positive `--cache-keepalive-pings` (or matching environment/
YAML setting) arms production keepalive; zero is the default, so startup adds no
background network requests. Each accepted foreground prompt replaces the prior
schedule, waits 295 seconds, and makes at most `--cache-keepalive-pings`
one-token refresh requests at that interval, ten being the largest value the
option accepts. The bound is per schedule, not per turn: replacing the schedule
restarts the count, so a turn that reflects several times arms a fresh run of
pings each time, exactly as pinned aider's `warm_cache` resets
`warming_pings_left` on every send. Only one schedule is ever live, and it is
idle whenever a foreground turn is not waiting. Every refresh ends at the last explicit cache marker: current
conversation and reminder content after the marker are never sent. No marker,
capability, or opt-in means no schedule. Background failures are ignored because
warming is an optimization, and replacement, model switch, or session/application
close clears the timer and aborts an in-flight refresh. Timers are unreferenced so
they cannot keep Node alive. This keeps aider's pinned cache-prefix and 295-second
cadence while adding explicit bounds and deterministic lifecycle cleanup.
Models declaring `assistantPrefill` enter a bounded continuation path in
production. DeepSeek receives `prefix: true` on the trailing assistant message
and uses the `/beta` endpoint, as described above; the OpenAI dialect sends an
ordinary assistant message. On each `length` stop, Patch trims only the current
fragment's trailing whitespace, replaces the single trailing assistant message
with the cumulative output, and treats the next provider response as a new suffix.
At most three follow-up requests are made. Usage and cost are aggregated across
all completed requests, while provider errors and cancellation stop immediately;
the final response enters history once. This matches the pinned aider replacement
flow while adding a finite bound. Anthropic documents trailing-assistant input as
an immediate continuation whose response is only the suffix; ordinary OpenAI Chat
Completions does not promise that contract, so Patch gates the behavior on model
capability rather than enabling it for every OpenAI-compatible endpoint.

`/attach <path...>` production-wires `buildReadOnlyMediaMessage`. Every new path
must be explicitly approved and remain inside the selected root; ignored paths
and symlink escapes fail closed. Patch accepts PNG, JPEG, WebP,
and PDF, verifies extension-specific signatures/terminators, and rejects encrypted
PDFs. Reads use a no-follow file handle, accept cancellation, and are bounded to
four files, 5 MiB each, and 10 MiB total—deliberately below provider maxima and
stricter than pinned aider's suffix-only unbounded reads. Model capability is
checked before bytes are read. OpenAI receives images only; PDFs require a model
with `documents` and the Anthropic adapter's native document block.

Approved bytes live only in the private application-session attachment map and
the active provider request. Prompt labels contain safe relative paths; completed
chat history, snapshots, command results, and diagnostics never receive encoded
bytes. `/drop` removes named media (or all media with no arguments), and session
close clears the map. Deterministic fake-provider tests prove image/PDF delivery,
approval, capability denial, malformed/oversized input, containment, cancellation,
history secrecy, and cleanup without network access.
