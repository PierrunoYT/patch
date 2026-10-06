# Contributing to Patch

Contributions are welcome. This document describes the process.

## Issues

- Issues and pull requests go to https://github.com/PierrunoYT/patch.
- Open work (bugs, follow-ups, ideas) is tracked in [the issues](https://github.com/PierrunoYT/patch/issues); there is no separate task list. Pick one there if you're looking for something to do.
- Before submitting an issue, please check if it already exists.
- Provide as much information as possible: what you did, what happened, what you expected, your OS and the model you used.
- Include step-by-step reproduction steps if you can.

## Pull Requests

- Fork the repository and create your branch from `main`.
- Add tests for new behavior: unit tests next to the code (`*.test.ts`), end-to-end tests in `tests/e2e/` for user-visible changes.
- Make sure `npm run format:check`, `npm run lint`, `npm run typecheck` and `npm test` pass; CI runs the same checks. `npm run format` fixes formatting.
- Base your branch on the current `main`, not on another open pull request. Stacked branches conflict once the earlier PR is merged.
- A pull request needs one approving review before it can be merged.
- Update the docs (`README.md`, `docs/`) and `CHANGELOG.md` when behavior changes.
- Mention the issue a pull request resolves (`Fixes #123`) so it closes on merge.

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup and where things live.

## Coding Conventions

- TypeScript, formatted with Prettier (`.prettierrc`): 2-space indentation, 120 columns, single quotes.
- Follow the style of the surrounding code.
- Write meaningful commit messages (Conventional Commits, e.g. `feat: …`, `fix: …`).

## License

By contributing, you agree that your new contributions will be licensed under the project's [Apache License, Version 2.0](LICENSE) (`Apache-2.0`). Submit only material you have the right to contribute under these terms, and preserve existing copyright and third-party license notices. This does not change the MIT permissions already granted for earlier contributions; see [README.md](README.md#license).
