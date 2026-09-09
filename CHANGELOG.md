# Changelog

All notable changes to Patch will be documented in this file.

The project has not published a release yet.

## [Unreleased]

### Added

- Initial project overview and development status.
- Patch wordmark and icon assets.
- A phased TypeScript, Node.js, and npm porting plan covering architecture,
  implementation tasks, compatibility testing, security risks, and release
  criteria, pinned to aider commit `5dc9490b`.
- Contributor guidance for implementation, verification, attribution, asset
  placement, required documentation maintenance, and commits after every
  completed task.
- TypeScript and npm project foundations with strict type checking, linting,
  formatting, tests, build output, package validation, and a minimal CLI.
- Apache-2.0 licensing, upstream attribution guidance, and machine-readable
  aider source revision metadata.
- Node.js 22 continuous integration for formatting, linting, type checking,
  tests, builds, and clean installation of the packed executable.
- A deterministic, revision-checked upstream fixture exporter covering config
  precedence, message chunks, SEARCH/REPLACE behavior, Git diffs, and repository
  maps without adding Python to the runtime package.
- Strict runtime schemas and inferred TypeScript contracts for messages,
  provider streams, edits, repositories, commands, model settings, and session
  state.
- A validated, deterministic fake provider for testing streamed text,
  reasoning, fragmented tool calls, usage, errors, truncation, retries, and
  cancellation without network access.
- Canonical, root-contained path resolution that rejects traversal, escaping
  symlinks, dangling symlinks, and out-of-root existing or missing targets.
- Encoding-aware text reads and atomic writes with line-ending and byte-order
  mark preservation, dry-run previews, permission retention, and containment
  revalidation before replacement.

### Changed

- Updated the project overview to link the porting plan and accurately describe
  the current foundation-stage implementation.
