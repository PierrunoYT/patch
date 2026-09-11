# Model catalog

Patch packages a small, provider-neutral model catalog under `src/resources/`.
The initial entries are `gpt-4o`, `gpt-4o-mini`, `claude-sonnet-4-6`,
`claude-haiku-4-5`, and `deepseek/deepseek-chat`, with the aliases `4o`,
`sonnet`, and `deepseek`.

The bundled DeepSeek entry keeps the `deepseek/deepseek-chat` routing name;
`createProvider` selects the `deepseek` dialect, which strips the prefix and
normalizes the output limit and prefill request for the endpoint. See
[model providers](providers.md) for the exact differences.

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

`reportUsage` can retain provider token counts and estimate cost from prices
present in the executable `ModelSettings`. `ModelCatalog.resolve()` currently
returns metadata separately and the concrete application does not merge its
limits, prices, or capabilities into settings. Bundled metadata prices therefore
do not produce executable cost reports. A final OpenAI-compatible usage event
that arrives after the finish event is retained, but the terminal does not
render usage reports. Unknown costs remain `null` rather than becoming a
misleading zero.
