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
- Before changing ported behavior, read the latest dated audit in
  `docs/aider-parity-audit-2026-09-15.md`, the consolidated queue in `task.md`,
  and the detailed live backlog in `docs/remaining-integration-tasks.md`, then
  read the documentation and upstream source for the affected subsystem.
- The latest dated source audit compares Patch commit
  `1bf2ca6adbc3f4774612590f3f7c59c636a4a6e9` with aider commit
  `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`. Keep both revisions explicit in
  new audit evidence. Preserve every dated audit and source inventory as a
  historical snapshot; reconcile current implementation status in `task.md`,
  the detailed backlog, the parity matrix, and subsystem documentation instead.
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

## Maintainer workflow

Use this sequence for parity audits and issue-fixing passes:

1. Inspect the Patch branch, worktree, and configured upstream before starting.
   Preserve unrelated or concurrent changes, and do not include them in the
   current issue. Audit clean committed trees; use another worktree when needed
   rather than disturbing existing work.
2. Read `upstream.json`, then clone or fetch aider outside this repository. The
   default reference location is the sibling `../aider-upstream`. Verify its
   `origin`, clean worktree, and exact pinned `HEAD` before using it as evidence.
3. Audit file-for-file against that pinned tree. Cover product modules, bundled
   runtime resources and queries, upstream test families, packaging, and
   workflows; distinguish exact parity, partial support, intentional hardening,
   accepted non-goals, and missing production wiring. For a new audit boundary,
   create new dated audit and source-inventory snapshots instead of rewriting
   old reports.
4. Reconcile every actionable finding in both tracking layers: `task.md` is the
   consolidated, deduplicated queue used for day-to-day priority order, while
   `docs/remaining-integration-tasks.md` is the detailed authoritative evidence
   and history. Keep priorities and completion status synchronized between them.
5. Fix one independently reviewable issue per implementation cycle, starting
   with the highest-priority actionable item. Trace or reproduce the behavior,
   compare the pinned upstream implementation, preserve intentional Patch
   security boundaries, and verify the executable production path rather than
   only an isolated helper.
6. Add focused regression and failure-path tests with the fix. Update `task.md`,
   the detailed backlog, parity matrix, affected subsystem documentation,
   `README.md`, `PORTING_PLAN.md`, and `CHANGELOG.md` wherever the issue changes
   their claims. Code, tests, and documentation for that issue belong in the
   same cohesive commit.
7. Apply formatting, run the narrowest useful checks while developing, then run
   the complete `npm run check` suite. Build and inspect the installed executable
   when the package or CLI surface changes, following the commands below.
8. Commit the verified issue before beginning the next one, push the current
   branch to its configured upstream without force, and verify the local and
   upstream branch state. If the user asks to keep a task local, do not push it.

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
- The user has explicitly requested standing push behavior: after each completed
  task is committed, push the current branch to its configured upstream unless
  the user says to keep that task local. Never force-push.
