# Model catalog

Patch packages a small, provider-neutral model catalog under `src/resources/`.
The initial entries are `gpt-4o`, `claude-sonnet-4-6`, and
`deepseek/deepseek-chat`, with the aliases `4o`, `sonnet`, and `deepseek`.

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
