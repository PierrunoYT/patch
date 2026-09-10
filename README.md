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

Patch is an unreleased, incomplete port with a working core application path.
The `patch` executable bootstraps configuration; resolves OpenAI, Anthropic, or
DeepSeek models; builds editable, read-only, and repository-map context; and
runs serialized one-shot or line-oriented interactive turns. The six constructed
formats are `ask`, `whole`, `diff`, `diff-fenced`, `udiff`, and `patch`.
Selected-file edits are dry-run resolved, previewed, written, optionally
committed, and followed by explicitly configured lint/test commands. Slash
commands dispatch through the same session queue.

This is not yet a usable-release or aider-parity claim. The executable has no
interactive approval prompt for new/out-of-chat writes or commands, no
post-write lint/test reflection loop, and incomplete failure/cancellation
coverage. Rich completion, history navigation, keybindings, editor and PTY
dispatch remain library helpers. Architect/context/cache/prefill/media helpers
are not constructed modes. `--watch-files` shares the terminal session, and
`--web` starts the local authenticated HTTP/SSE API (not a browser GUI).
URL context integration and web session expiry/backpressure policy remain
unfinished. See the unchecked items in
[`docs/remaining-integration-tasks.md`](docs/remaining-integration-tasks.md) for
the authoritative remaining scope.

Implemented foundations include strict TypeScript validation, deterministic
fake-provider tests, [safe filesystem behavior](docs/filesystem-safety.md),
staged [configuration bootstrap](docs/configuration-bootstrap.md), a packaged
[model catalog](docs/model-catalog.md), real Git adapters, and a packaged
five-language [repository-map engine](docs/repository-maps.md). There is no
published package or stable interface.

See the [porting plan](PORTING_PLAN.md) for implementation progress and the
[changelog](CHANGELOG.md) for notable changes. Pinned upstream behavior is
recorded using the documented
[compatibility-fixture workflow](docs/compatibility-fixtures.md).
Library adapters include security-bounded [URL fetching](docs/url-fetching.md),
[AI comment watch mode](docs/watch-mode.md), and an authenticated,
session-isolated [local HTTP/SSE interface](docs/web-interface.md). Watch and web
startup use only built-in Node.js adapters; no browser/native package is installed.
Bounded [voice recording and transcription](docs/voice-input.md)
is available through an optional package subpath and can submit to an explicit
application session without native default dependencies.

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

Use `patch --watch-files --model 4o file.ts` to process changed `AI!`/`AI?`
comments while terminal input stays open. Git and `.aiderignore` rules apply
unless `--no-git` is selected. `AI?` turns cannot apply edits or run commands;
`AI!` preserves the normal selected-file authorization boundary. EOF, `/exit`,
Ctrl-C, or SIGTERM stops watching and closes the application.

Use `patch --web --web-token-file /path/outside/repo/patch-token --model 4o`
for the experimental local API. Generate a random token and protect its file as
described in [web setup](docs/web-interface.md). The server prints its loopback
address, never the token; `--web-port` optionally selects a port. Stop it with
Ctrl-C or SIGTERM. Web and watch flags are explicit CLI-only startup choices,
cannot be combined with each other or one-shot input, and use the same staged
model/file configuration as terminal startup. This API is for trusted local
clients, not public or multi-tenant hosting.

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

Directly ported files identify their aider source revision and
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
