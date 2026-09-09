<p align="center">
  <img src="assets/logo.svg" alt="Patch wordmark" width="300">
</p>

<h1 align="center">Patch</h1>

<p align="center">
  <strong>AI pair programming in your terminal.</strong>
</p>

Patch is an early-stage TypeScript port of [Aider](https://github.com/Aider-AI/aider),
using Node.js and npm. The goal is to bring Aider's terminal coding workflow to
TypeScript while preserving upstream attribution under Apache-2.0.

## Project status

Patch is an early, runnable prototype. It sends your request and explicitly
selected files to an OpenAI-compatible model, streams the response, and previews
proposed edits as a Git-generated diff. Files are changed only after interactive
approval. There is no published package or stable interface yet.

The integrated port includes coder planners, native provider/session APIs,
Git/configuration services, repository maps and context tools, plus terminal and
authenticated browser adapters. `--chat` and `--gui` connect sessions to reviewed
file operations. Not every library capability or upstream option is wired into
the application yet. This is not a complete Aider port.
See the [port inventory and compatibility differences](docs/design-references.md).

See [development notes](docs/development.md) and [provider documentation](docs/providers.md).
Notable changes are recorded in the [changelog](CHANGELOG.md).

Interactive sessions ask for a model if none is configured. OpenRouter users
without a key can approve a same-machine browser login; credentials remain in
memory for that session. No browser opens automatically and remote orb callback
bridging is not implemented. See [onboarding boundaries](docs/porting/onboarding.md).

Read [AGENTS.md](AGENTS.md) for repository guidance, including the requirement to
create or update relevant documentation after every task or code change.

## Try it from source

Requires **Node.js 22+**, **npm**, and **Git**.

```sh
npm ci
npm run build
npm start -- --help
```

Generate a static completion script with
`node dist/src/cli.js --shell-completions bash` (also `zsh` or `tcsh`).
This prints the script without a model, config-file reads or shell installation.
Zsh requires `compinit` before sourcing; option-value completion is not supported.

Set `OPENAI_API_KEY` in your environment and choose a Chat Completions model.
To try the ported SEARCH/REPLACE format without writing anything:

```sh
npm start -- --model YOUR_MODEL --edit-format diff --file src/app.ts --dry-run "Suggest a small readability improvement"
```

Omit `--dry-run` to review and approve edits in an interactive terminal. A
positional request runs a single turn through the same engine, configuration and
approvals as a session; it is equivalent to `--message`. To start a multi-turn
session instead:

```sh
npm start -- --chat --model YOUR_MODEL --edit-format diff --file src/app.ts
```

Session mode supports reviewed creation/deletion as well as updates, command
dispatch, and individually approved shell suggestions. `--gui` starts the same
session host in a local browser; its private loopback URL is not an orb portal.
Explicitly selected images and PDFs are read-only model attachments in session
mode. Browser `/editor` drafts require a fresh Send, just like terminal review.
Opt-in file watching and clipboard polling queue reviewable drafts; they never
submit automatically. Running without arguments enters terminal session startup.
Browser state controls prepare commands for explicit Send, alongside safe Markdown
responses and live session usage. Terminal palettes are optional and TTY-only.
Interactive terminal input includes a selectable Tab completion menu; Enter inserts
the selection and a second Enter submits. `--no-fancy-input` uses basic line input;
`--multiline` collects lines until Meta+Enter (or a standalone `}`). Four menu
colors and five output/input role colors are configurable; `--no-pretty` and
`NO_COLOR` suppress styling. See [terminal input details](docs/porting/interfaces.md#native-terminal-completion-menu-and-input-options).
Real terminal sessions can use the optional native PTY runner for reviewed
commands; child control sequences are escaped rather than executed by the UI.
Explicit history paths enable separately approved logs and restoration; logs can
contain sensitive content, and no history files are created by default.
See [usage and safety limits](docs/usage.md) before editing real projects.

## Technology direction and references

The implementation uses TypeScript with Node.js and npm. Bun is an option
to evaluate later, not a current runtime or tooling requirement.

Ported files identify their Aider source revision and modifications. Reference
checkouts remain outside this repository; only scoped, tested ports are integrated.
The earlier independent-implementation plan has been replaced by a direct,
staged port. The prototype's own `tools` edit format has been retired; every mode
now uses the ported coder formats and defaults to the model's own format.

## License

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
Patch is not an official Aider release and does not imply upstream endorsement.

## Brand assets

- [Patch wordmark](assets/logo.svg)
- [Patch icon](assets/logo-icon.svg)

Both logos are SVGs with mint lettering on a charcoal background.
