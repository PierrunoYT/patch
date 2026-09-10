<p align="center">
  <img src="assets/logo.svg" alt="Patch wordmark" width="300">
</p>

<h1 align="center">Patch</h1>

<p align="center">
  <strong>AI pair programming in your terminal.</strong>
</p>

<p align="center">
  <a href="https://discord.gg/sk9Q28VnYG">
    <img src="https://img.shields.io/badge/Discord-Join%20community-5865F2?logo=discord&amp;logoColor=white" alt="Join the Patch Discord community">
  </a>
</p>

Patch is an early-stage TypeScript port of [Aider](https://github.com/Aider-AI/aider),
using Node.js and npm. The goal is to bring Aider's terminal coding workflow to
TypeScript while preserving upstream attribution under Apache-2.0.

## Project status

Patch is at the foundation stage. The repository has a strict TypeScript build,
linting, formatting, tests, automated CI, npm package smoke testing, a
`patch` executable, validated
[domain contracts](docs/domain-contracts.md), a deterministic provider test
harness, [safe path resolution](docs/filesystem-safety.md), and upstream license
and revision metadata. The filesystem adapter also provides validated text
encoding, line-ending preservation, dry runs, and atomic replacement. Model
connections, edit parsing, Git workflows, and interactive sessions have not
all been integrated yet. The executable now bootstraps configuration, resolves
OpenAI, Anthropic, or DeepSeek models, composes safe editable/read-only and
repository-map context, and runs serialized one-shot or interactive provider
turns. Applying edits and the complete Git/check command lifecycle remain
integration work. Shared [prompt resources and fence selection](docs/prompts.md)
and typed chat composition with upstream-compatible ordering, capability-aware
cache boundaries, continuation, and read-only media context are pinned to
upstream behavior. Staged
[configuration bootstrap](docs/configuration-bootstrap.md) now discovers a
provisional Git root, searches config and dotenv paths, and corrects the root
from selected files. A validated, packaged [model catalog](docs/model-catalog.md)
provides the first provider-neutral aliases, settings, and metadata. There is no
published package or stable interface. The initial
[coder session](docs/coder-session.md) composes injected providers and edit
strategies through dry-run resolution and transactional staging. Lint and test
checks run only when explicitly configured; Patch never guesses commands from
the target repository's package-manager files. The packaged
[repository-map engine](docs/repository-maps.md) extracts five initial language
families with Tree-sitter, ranks references deterministically, and renders
syntax context within token budgets using persistent content-aware caches.

See the [porting plan](PORTING_PLAN.md) for implementation progress and the
[changelog](CHANGELOG.md) for notable changes. Pinned upstream behavior is
recorded using the documented
[compatibility-fixture workflow](docs/compatibility-fixtures.md).
Optional interfaces now include security-bounded [URL fetching](docs/url-fetching.md)
without adding Playwright to the default installation and serialized
[AI comment watch mode](docs/watch-mode.md).
An authenticated, session-isolated [local HTTP/SSE interface](docs/web-interface.md)
uses the same application-service contract without adding a web framework.
Bounded [voice recording and transcription](docs/voice-input.md) is available
through an optional package subpath without native default dependencies.

Read [AGENTS.md](AGENTS.md) for repository guidance, including the requirement to
create or update relevant documentation after every task or code change.

## Try it from source

Requires **Node.js 22+**, **npm**, and **Git**.

```sh
npm ci
npm run check
npm start -- --help
```

The executable accepts `--message`, `--message-file`, or interactive line input.
Select a model with `--model`, `PATCH_MODEL`, or `.patch.conf.yml`; provider
credentials use `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `DEEPSEEK_API_KEY`.
Editable files can be positional or repeated `--file` values; use
`--read-only` for context that must not be edited. The currently constructed
formats are `ask`, `whole`, `diff`, `diff-fenced`, `udiff`, and `patch`.
Advanced schema values are rejected rather than silently accepted. See the
[provider documentation](docs/providers.md) and [input modes](docs/input-modes.md).
Rich terminal contracts and history privacy guidance are documented in
[rich terminal behavior](docs/terminal.md).

Architect/editor handoff, context convergence, cache keepalive, prefill, and
media utilities are currently library-level contracts, not constructed CLI
modes. `help`, `udiff-simple`, `architect`, `context`, and `editor-*` are
therefore rejected by `--edit-format` and `/chat-mode` until their complete
application behavior and independent evidence exist.

## Technology direction and references

The implementation uses TypeScript with Node.js and npm. Bun is an option
to evaluate later, not a current runtime or tooling requirement.
See the [Aider-to-Patch porting plan](PORTING_PLAN.md) for the pinned upstream
baseline, target architecture, implementation phases, and verification criteria.

Directly ported files will identify their aider source revision and
modifications. Reference checkouts remain outside this repository; only scoped,
tested ports will be integrated.

## Community

Join the [Patch Discord community](https://discord.gg/sk9Q28VnYG).

## License

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
Patch is not an official Aider release and does not imply upstream endorsement.

## Brand assets

- [Patch wordmark](assets/logo.svg)
- [Patch icon](assets/logo-icon.svg)

Both logos are SVGs with mint lettering on a charcoal background.
