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

Patch is at the foundation stage. The repository has a strict TypeScript build,
linting, formatting, tests, automated CI, npm package smoke testing, a minimal
`patch --help` executable, validated
[domain contracts](docs/domain-contracts.md), a deterministic provider test
harness, [safe path resolution](docs/filesystem-safety.md), and upstream license
and revision metadata. The filesystem adapter also provides validated text
encoding, line-ending preservation, dry runs, and atomic replacement. Model
connections, edit parsing, Git workflows, and interactive sessions have not
been implemented yet. Shared [prompt resources and fence selection](docs/prompts.md)
and typed chat composition with upstream-compatible ordering and cache
boundaries are pinned to upstream behavior. There is no published package or
stable interface.

See the [porting plan](PORTING_PLAN.md) for implementation progress and the
[changelog](CHANGELOG.md) for notable changes. Pinned upstream behavior is
recorded using the documented
[compatibility-fixture workflow](docs/compatibility-fixtures.md).

Read [AGENTS.md](AGENTS.md) for repository guidance, including the requirement to
create or update relevant documentation after every task or code change.

## Try it from source

Requires **Node.js 22+**, **npm**, and **Git**.

```sh
npm ci
npm run check
npm start -- --help
```

The executable currently exposes help only. It does not edit files or call a
model.

## Technology direction and references

The implementation uses TypeScript with Node.js and npm. Bun is an option
to evaluate later, not a current runtime or tooling requirement.
See the [Aider-to-Patch porting plan](PORTING_PLAN.md) for the pinned upstream
baseline, target architecture, implementation phases, and verification criteria.

Directly ported files will identify their aider source revision and
modifications. Reference checkouts remain outside this repository; only scoped,
tested ports will be integrated.

## License

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
Patch is not an official Aider release and does not imply upstream endorsement.

## Brand assets

- [Patch wordmark](assets/logo.svg)
- [Patch icon](assets/logo-icon.svg)

Both logos are SVGs with mint lettering on a charcoal background.
