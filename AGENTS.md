# Patch contributor guidance

## Project direction

- Patch is a TypeScript port of aider for Node.js 22+ and npm.
- Follow `PORTING_PLAN.md` for scope, architecture, phase order, compatibility
  requirements, and the pinned upstream revision.
- Keep the aider reference checkout outside this repository. Never copy the
  checkout into Patch or add it as a submodule.
- Patch must not depend on Python or invoke aider at runtime.
- Preserve Apache-2.0 attribution. Directly ported files must identify their
  upstream path and revision and state that they were modified for Patch.

## Current parity baseline

- Patch is a substantial partial port, not a complete aider-compatible
  implementation. Do not turn implemented helpers, exported contracts, or
  isolated tests into broader compatibility claims.
- Before changing ported behavior, read the pinned parity audit and priority
  backlog in `docs/remaining-integration-tasks.md`, then read the documentation
  and upstream source for the affected subsystem.
- The current source audit compares Patch commit
  `58597efc390e8e138b29024871a25d192fb27462` with aider commit
  `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`. Keep both revisions explicit when
  updating audit evidence.
- Treat every unchecked P0 item in the authoritative integration backlog as a
  release blocker. Do not mark a phase complete because a library helper exists;
  verify the behavior through the executable production path.
- Distinguish production-wired behavior from helper-only, fixture-only, and
  planned behavior in code comments, tests, plans, changelog entries, and user
  documentation.
- Preserve intentional Patch hardening instead of weakening containment,
  authorization, ambiguity rejection, process bounds, or network isolation
  merely to mimic aider. Document the intentional difference and its tradeoff.
- When touching an audited subsystem, compare it again with the pinned aider
  source and update the parity matrix, prioritized backlog, and relevant
  subsystem documentation in the same change.

## Implementation

- Use TypeScript, ESM, Node.js, and npm. Do not introduce another runtime or
  package manager without an explicit project decision.
- Prefer the simplest implementation that preserves the required behavior.
- Keep provider, repository, filesystem, process, and interface adapters behind
  explicit contracts; keep the session core independent of those adapters.
- Use the installed Git CLI for repository behavior rather than reimplementing
  Git semantics.
- Treat model output, paths, configuration, subprocess output, and network
  responses as untrusted input. Validate boundaries and prevent writes outside
  the selected repository root.
- Require explicit user approval before running model-suggested commands or
  editing new and out-of-chat files.
- Keep `assets/` limited to `logo.svg` and `logo-icon.svg`. Runtime resources
  belong under the source tree and must be included explicitly in npm packages.

## Commands

- Install exactly from the lockfile with `npm ci`.
- Run the complete local validation suite with `npm run check`.
- Build the executable with `npm run build`, then inspect it with
  `npm start -- --help`.
- Regenerate pinned compatibility fixtures with `npm run fixtures:upstream`;
  this requires the external aider checkout described in
  `docs/compatibility-fixtures.md`.
- Use `npm run format` to apply formatting; do not hand-format generated output.

## Testing and verification

- Add tests for each behavior change. Prefer focused unit tests, real temporary
  Git repositories for Git behavior, and deterministic fake providers for model
  flows.
- Use compatibility fixtures tied to the pinned aider revision when porting
  upstream behavior.
- Test failure, cancellation, malformed-output, path-containment, and partial
  write scenarios—not only successful paths.
- Run the narrowest relevant checks during development and the full available
  validation suite before completing a task.
- Never require live provider credentials in the default test suite.

## Documentation

- After every completed task or code change, create or update the relevant
  documentation before considering the work complete.
- Keep `README.md` accurate for user-visible behavior, `PORTING_PLAN.md` current
  for architecture and phase progress, and `CHANGELOG.md` updated for notable
  changes.
- Document intentional differences from aider and link behavior claims to the
  pinned upstream source or compatibility tests.

## Completion

- After completing and verifying each task, commit its cohesive code and
  documentation changes before considering the task complete.
- Do not push commits unless the user explicitly requests a push.
