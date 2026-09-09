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
- Pinned common prompt resources and source-aware fence selection with exact
  compatibility fixtures for candidate order, collisions, and fallback.
- Validated chat chunks with upstream-compatible role ordering, immutable cache
  marking, defensive output copies, and normalized provider cache boundaries.
- Staged configuration bootstrap with Git CLI root discovery, ordered Patch
  config and dotenv searches, strict final argument parsing, and one-pass root
  correction for files selected from another repository.
- Validated YAML configuration with explicit precedence across defaults, home,
  repository, working-directory and explicit config files, environment,
  dotenv, and command-line values.
- A packaged, validated model catalog with aliases, YAML settings, commented
  JSON5 metadata, deterministic overrides, and clean-install resource checks.
- A provider-neutral edit-strategy contract and an `ask` strategy that cannot
  emit file edits or shell commands.
- Whole-file fenced-block parsing with upstream-compatible filename inference,
  reliability ordering, duplicate suppression, and trailing-newline behavior.
- SEARCH/REPLACE parsing and pure application with shell-block separation,
  exact and indentation-aware matching, paired elision, ambiguity rejection,
  and contextual failure diagnostics.
- Pure edit-batch dry-run resolution against immutable file snapshots, with
  sequential same-file edits and all-or-nothing failure results.
- Explicit resolved create, update, and delete operations, including
  deterministic move expansion and original content for stale-write protection.
- Transactional edit staging that validates every path, snapshot, and encoded
  result before authorization or writes, then revalidates before commit.
- Property-based edit-engine coverage for malformed fences, repeated matches,
  empty files, Unicode, CRLF, duplicate filenames, and traversal attempts.
- An initial `CoderSession` that composes injected provider and edit-strategy
  contracts through validated parsing, dry-run resolution, and edit staging.

### Changed

- Updated the project overview to link the porting plan and accurately describe
  the current foundation-stage implementation.
