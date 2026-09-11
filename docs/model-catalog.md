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
- YAML settings use the strict `ModelSettingsSchema` contract; and
- commented JSON5 metadata has validated token limits, costs, provider, and
  capability fields.

Additional resource files can be supplied to `load`; they are applied after
the bundled files and replace entries with the same alias or model name. Invalid
or unreadable resources identify their source in `ModelResourceError`. Catalog
lookups return defensive copies so one caller cannot mutate later resolutions.

The build copies these runtime resources into `dist/resources`, and the package
smoke test loads the catalog from a clean tarball installation. This initial
catalog is intentionally narrow: provider expansion should add tested settings
rather than importing aider's LiteLLM-specific catalog wholesale.

`selectModels` resolves main, weak, and editor roles as a library helper.
Explicit role names and editor formats follow Aider-like precedence without
recursive secondary construction. The concrete application currently constructs
only the main provider/session; weak/editor roles and their consuming workflows
are not executable behavior.

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
Bundled metadata prices therefore reach executable cost reports. A final
OpenAI-compatible usage event that arrives after the finish event is retained,
and `ApplicationTurnResult` carries the report and the running `sessionCost`, so
the terminal prints one accounting line after each turn: tokens sent, cached,
and received, then the turn and session cost. Unknown costs remain `null` and
render as tokens alone rather than becoming a misleading zero, and a turn under
a cent keeps four decimals so it does not display as `$0.00`.

## Temperature

`useTemperature` decides what a request carries: `false` sends no temperature,
for models that reject the parameter; `true` — the default — sends `0`; and a
number sends that value. `deepseek/deepseek-reasoner` sets `false`, as upstream
records for DeepSeek R1. Patch previously sent no temperature at all, so
sampling followed each endpoint's own default rather than a deterministic one.
