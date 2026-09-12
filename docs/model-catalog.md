# Model catalog

Patch packages a small, provider-neutral model catalog under `src/resources/`.
The initial entries are `gpt-4o`, `gpt-4o-mini`, `claude-sonnet-4-6`,
`claude-haiku-4-5`, `deepseek/deepseek-chat`, and
`deepseek/deepseek-reasoner`, with the aliases `4o`, `sonnet`, `deepseek`, and
`r1`.

The bundled DeepSeek entries keep their `deepseek/` routing names;
`createProvider` selects the `deepseek` dialect, which strips the prefix and
normalizes the output limit and prefill request for the endpoint. See
[model providers](providers.md) for the exact differences.

`reasoningTag` names the tag a model wraps its reasoning in inside the ordinary
content stream; `deepseek/deepseek-reasoner` carries `think`, as upstream
assigns to DeepSeek R1. Providers that deliver reasoning on its own stream set
no tag. See [coder session](coder-session.md) for how a tagged span is split out
of display, history, and edit parsing.

The aliases and selection behavior are adapted from
[`aider/models.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/models.py#L98-L125),
settings from
[`model-settings.yml`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/resources/model-settings.yml),
and metadata from
[`model-metadata.json`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/resources/model-metadata.json).
Each directly adapted resource also carries its source revision and describes
its Patch-specific normalization.

`ModelCatalog.load()` validates all three resource kinds before exposing them:

- aliases are non-empty name mappings and alias cycles are rejected;
- YAML settings use the strict `ModelSettingsSchema` contract, whose
  `editFormat` and `editorEditFormat` fields accept only `ask`, `whole`, `diff`,
  `diff-fenced`, `udiff`, or `patch`; and
- commented JSON5 metadata has validated token limits, costs, provider, and
  capability fields.

Bundled editor roles record the parser they actually use (`diff`), not aider's
internal `editor-diff` coder name. Distinct editor prompting and lifecycle are
construction policy, not a seventh public format. Helper-only names therefore
fail catalog loading before provider construction.

Additional resource files can be supplied to `load`; they are applied after
the bundled files and replace entries with the same alias or model name. Invalid
or unreadable resources identify their source in `ModelResourceError`. Catalog
lookups return defensive copies so one caller cannot mutate later resolutions.

The build copies these runtime resources into `dist/resources`, and the package
smoke test loads the catalog from a clean tarball installation. This initial
catalog is intentionally narrow: provider expansion should add tested settings
rather than importing aider's LiteLLM-specific catalog wholesale.

`selectModels` resolves main, weak, and editor roles without recursive secondary
construction. Explicit role overrides are library options, not executable
controls. The concrete application constructs the main provider/session and
resolves the active main model's weak model when compacting long history, so a
model switch also changes subsequent summarization. The internal editor path now
constructs the selected editor provider and parser on demand with fresh history,
current selected paths, and the editor model's capabilities. Architect handoff
uses that path only after explicit acceptance and transfers usage/commit state
back to the main session. Generated commit-message role selection is unchanged.

## Token counting

`countMessageTokens` uses `tiktoken` with `o200k_base` or `cl100k_base` for
recognized OpenAI text-only models. Unknown models and multimodal prompts use a
conservative UTF-16-length estimate and return `method: "conservative"` so the
result cannot be mistaken for an exact provider count. `CoderSession` uses this
model-aware boundary for prompt budgets and permits an injected counter when a
provider exposes a more authoritative tokenizer.

## Usage and cost

`reportUsage` retains provider token counts and estimates cost from prices in
the executable `ModelSettings`. `ModelCatalog.resolve()` folds each metadata
entry into those settings: settings describe behavior, metadata describes the
endpoint's limits, prices, and capabilities, and metadata wins for the fields it
defines, as upstream's `model-metadata.json` overrides LiteLLM's model info.
Capabilities merge key by key, so an entry need only state what it changes, and
`resolve()` still returns the raw `metadata` alongside the merged settings.
Metadata capability parsing has no defaults: omitted keys cannot overwrite a
setting's explicit image, document, tool, or streaming capability with `false`.
The bundled GPT-4o entries declare their documented image capability; PDF input
remains disabled for OpenAI Chat Completions.
Bundled metadata prices therefore reach executable cost reports. A final
OpenAI-compatible usage event that arrives after the finish event is retained,
and `ApplicationTurnResult` carries the report and the running `sessionCost`, so
the terminal prints one accounting line after each turn: tokens sent, cached,
and received, then the turn and session cost. Unknown costs remain `null` and
render as tokens alone rather than becoming a misleading zero, and a turn under
a cent keeps four decimals so it does not display as `$0.00`.

Every advertised bundled model now carries an input limit, an output limit, and
catalog prices, and `tests/model-metadata-merge.test.ts` fails when an entry is
added without them. Upstream ships metadata only for the models LiteLLM's data
misses and reads the rest from LiteLLM at runtime; Patch has no such database,
so these values come from LiteLLM 1.84.10's
`model_prices_and_context_window_backup.json`, the table the pinned aider
revision resolves them from. They are a snapshot of vendor pricing at that
version rather than a live quote, and a deployment that needs current prices
supplies its own metadata file.

Each value is taken from the row for the transport Patch actually uses. That is
not always the largest row in the table: `claude-sonnet-4-6` appears with a
one-million-token window under `openrouter/`, while every direct, Bedrock, and
Vertex row is 200k, because the larger window is a beta that has to be requested
with a header this client does not send. Budgeting against the 1M figure would
pass a 300k prompt locally and have the API refuse it, and would price it with
flat rates that ignore Anthropic's long-context tier.

The limits are load-bearing, not decoration: a prompt over the model's
`maxInputTokens` is refused before the provider call, and the repository-map
budget is sized from the same number. `tests/interface-startup.test.ts` sends an
oversized selection through `gpt-4o` and the same selection through
`claude-sonnet-4-6`, whose window is larger, and asserts the first never reaches
the provider.

Cache pricing is modeled. `cachedInputCostPerMillion` and
`cacheWriteCostPerMillion` price the two subsets of the input count separately,
so a turn served largely from the cache costs a fraction of an uncached one and
a turn that paid to fill the cache is charged the premium. A model that prices
neither falls back to the ordinary input price, which leaves its total exactly
where it was. A provider-supplied cost still takes precedence over the whole
calculation.

Providers disagree about what an input count contains, so each adapter
normalizes to one contract: `inputTokens` is every billed input token, and
`cachedInputTokens` and `cacheWriteTokens` name the subsets inside it. OpenAI's
`prompt_tokens` already includes its cached tokens; Anthropic reports cache
reads and cache writes beside a prompt count that excludes both, so the
Anthropic adapter folds them in. The terminal's accounting line names a cache
write separately from the sent count. Evidence: `tests/usage.test.ts`, the usage
case in `tests/anthropic-provider.test.ts`, and the rendering case in
`tests/render.test.ts`.

## Temperature

`useTemperature` decides what a request carries: `false` sends no temperature,
for models that reject the parameter; `true` — the default — sends `0`; and a
number sends that value. `deepseek/deepseek-reasoner` sets `false`, as upstream
records for DeepSeek R1. Patch previously sent no temperature at all, so
sampling followed each endpoint's own default rather than a deterministic one.
