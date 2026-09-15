# Aider parity audit — 2026-09-15 (`c9c59c6`)

## Reproducible boundary

This audit compares clean source trees at:

- Patch `c9c59c6157a60ebcaf890dfbf89b845b67bc1e42`; and
- canonical aider `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`.

The aider checkout remained outside Patch at `../aider-upstream`, with the canonical origin and exact `upstream.json` commit. The independent pinned Git-tree manifest remains 80 Python product modules, two model resources, and 58 Tree-sitter queries. The companion [current source inventory](aider-source-inventory-2026-09-15-c9c59c6.md) carries forward the complete manifest and records every changed classification since the historical `1bf2ca6` snapshot.

The review compared CLI/configuration, providers/models, coder/edit lifecycle, Git/filesystem/process boundaries, repository maps, commands/terminal behavior, optional interfaces, packaging, tests, and current documentation. Production reachability and helper-only behavior were kept separate.

## Verdict

Patch is a substantial, production-wired TypeScript port of aider's core workflow, not a 1:1 replacement. No open P0 or P1 supported-surface defect was found at this boundary. All previously reported 2026-09-15 parser, retry-observer, model metadata/default, Windows tokenization, clipboard-process, read-containment, reasoning-display, and ffmpeg pre-abort defects are fixed in production paths.

The remaining release evidence gap is external: Anthropic completed a credentialed catalog/factory/application turn; the available OpenAI account returned rate-limit errors and no DeepSeek credential was available. Deterministic tests cover all three production routes, but they are not live-provider evidence.

> Superseded for semantic findings by the
> [deep audit at Patch `5eecc98`](aider-deep-audit-2026-09-15-5eecc98.md).
> This snapshot remains the file-inventory boundary before those fixes.

## Feature and porting-state comparison

| Area                         | Pinned aider                                                                                                  | Patch at `c9c59c6`                                                                                                                                 | Classification                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Runtime/package              | Python application with Python/Docker release surfaces                                                        | Node.js 22+ ESM npm package; no Python/aider runtime                                                                                               | Implemented Patch scope; distribution parity is a non-goal                                                                 |
| Providers                    | LiteLLM-backed broad provider/model surface plus provider-specific integrations                               | Explicit OpenAI, Anthropic, and DeepSeek routes; six bundled models; strict custom catalog overlays                                                | Partial by deliberate provider scope; OpenAI/DeepSeek live evidence open                                                   |
| Public edit formats          | Registered whole, diff, diff-fenced, patch, udiff, udiff-simple, ask/help/architect/context/editor identities | Six public formats: `ask`, `whole`, `diff`, `diff-fenced`, `udiff`, `patch`; architect/context/editor are private application workflows            | Implemented selected formats; prompt-only `udiff-simple`, help coder, and public advanced modes are non-goals              |
| Edit application             | Broader fuzzy/recovery behavior, sometimes first-match                                                        | Exact and bounded recovery with ambiguity rejection, immutable snapshots, preview/approval, staged validation, atomic per-file replacement         | Implemented Patch scope with intentional hardening; no cross-file rollback                                                 |
| Conversation lifecycle       | Streaming coder subclasses, retries, reflection, history summary                                              | Provider-neutral session, attempt-atomic observer events, bounded retries/reflection, weak-model history summary and format-switch summary         | Implemented Patch scope; delayed publication intentionally avoids stale retry output                                       |
| Models and controls          | Large model resources, dynamic LiteLLM metadata, many configuration controls                                  | Six bundled profiles, bounded aliases/settings/metadata overlays, independent main/weak/editor roles, capability-gated reasoning/thinking controls | Partial breadth; selected resource defaults/limits match pinned aider                                                      |
| Commands                     | 43 `cmd_*` methods plus `!` and prefix matching                                                               | 28 exact slash commands with parser/completion/docs inventory equality                                                                             | Implemented selected surface; aliases, command files, broad Git/debug commands, and compound reset semantics are non-goals |
| Git                          | Broad configurable Git/ignore/commit behavior                                                                 | Literal selected paths, composed Git + `.aiderignore`, checkpoints/commits, hooks policy, selected diff, CAS/session-owned undo                    | Partial breadth with stronger containment and ownership rules                                                              |
| Filesystem                   | Direct text IO through Python codecs and configured line endings                                              | Contained canonical paths, strict UTF-8/UTF-16LE/Latin-1, preserve line endings, metadata checks, sibling atomic replacement                       | Implemented Patch scope with documented ACL/xattr/ADS and cross-file limits                                                |
| Repository map               | Larger dynamic query inventory and public sizing/refresh controls                                             | Eleven shipped language entries, lexical fallback, model-derived internal budgets, deterministic ranking/rendering/cache, `/map`                   | Partial breadth; selected scope is complete and packed; 46 pinned queries remain unported/non-selected                     |
| Lint/test/process            | Built-in/language lint paths and broad one-shot controls                                                      | One explicit bounded lint command and one test command; approved bounded shell/optional PTY                                                        | Intentional narrower scope; no command inference or universal dry-run claim                                                |
| Terminal                     | Rich rendering, configurable presentation, Vi/fancy input                                                     | Dependency-free streaming renderer, sanitizer, completion, history, multiline, external editor, notifications, optional PTY                        | Implemented minimal terminal scope; Rich renderer/computed previews/true Vi are non-goals                                  |
| Clipboard/media              | Text/image clipboard behavior and broader media flows                                                         | Bounded cancellable text clipboard; explicit approved contained image/PDF attachment                                                               | Intentional privacy/containment difference                                                                                 |
| URL/watch                    | URL detection/browser-capable scraping and watch mode                                                         | Explicit DNS-pinned bounded `/web`, no subresources; contained watch reads and shared application lifecycle                                        | Implemented Patch scope with intentional network hardening                                                                 |
| Browser interface            | Streamlit GUI                                                                                                 | Authenticated loopback HTTP/SSE API with quotas, replay/backpressure, expiry, and in-process worktree serialization                                | API implemented; browser GUI is a non-goal                                                                                 |
| Voice                        | CLI/device recording and transcription                                                                        | Optional `@pierrunoyt/patch/voice` embedding adapter with bounded cancellation/cleanup                                                             | Helper implemented; CLI/device UX is a non-goal                                                                            |
| Persistence/telemetry/update | Default histories, optional restoration/wire log, analytics, onboarding, update flows                         | Opt-in human-facing histories; no provider-ready restore/wire log, analytics, OAuth/onboarding, or updater                                         | Intentional privacy/maintenance differences                                                                                |

## Quantitative surface evidence

- Patch has 96 tracked files under `src/`, including runtime resources; aider's complete `aider/` tree has 521 tracked paths including queries and website content.
- The product comparison boundary remains 80 aider Python modules, two model resources, and 58 query files; website/build/media paths are not runtime features.
- Patch registers 28 exact slash commands; pinned aider defines 43 `cmd_*` methods and additionally accepts `!` as a run alias.
- Patch registers 48 Commander option declarations including paired negative/hidden controls; pinned aider contains 120 `add_argument` calls. These counts describe surface size, not semantic equivalence.
- Patch packages six bundled model profiles, six public edit formats, and eleven repository-map language entries.

## Confirmed intentional differences

Patch should not weaken these boundaries to mimic aider:

- ambiguity rejection and bounded edit recovery;
- explicit approval for model-suggested commands and new/out-of-chat writes;
- literal Git paths, composed ignores, selected disclosure, and session-owned undo;
- verified contained reads and atomic per-file replacement;
- explicit named providers, credential variables, and bounded networking;
- no implicit URL detection, browser subresources, clipboard images, analytics, onboarding, updater, or default transcript persistence;
- exact command names instead of prefix/alias/command-file execution; and
- process-local recovery claims rather than a false durable transaction guarantee.

## Stale documentation found

The historical `2026-09-15` audit and source inventory correctly remain frozen at Patch `1bf2ca6`, but live documentation still cited them as current. Additional stale live claims included:

- 20 commands instead of 28;
- clipboard utilities lacking bounds;
- Windows editor tokenization remaining defective;
- variable fences, close-only reasoning, media/watch ancestor containment, model defaults/limits, and unified-diff P0 defects still being open;
- incompatible model switches dropping assistant history instead of summarizing it;
- repository-map controls, Rich terminal work, browser GUI, and CLI voice described as deferred decisions after explicit non-goal decisions; and
- old 63-derivation/685-test validation text presented without a historical qualifier.

This audit adds a current snapshot and reconciles the task register, live backlog/matrix, porting plan, README, and affected subsystem documentation. Historical dated snapshots are not rewritten.

## Evidence limits

This source audit did not run a new remote Node 22 matrix, real microphone/device path, browser GUI, or successful OpenAI/DeepSeek live turn. Existing CI run `34987388922` remains evidence only for revision `44dbae712d96cf6abdf65055d3b83ecdb9ec55e0`; local validation cannot substitute for revision-specific remote or credentialed evidence.

## Local verification

On Windows, `npm run check` passed for the reconciled audit change: formatting,
ESLint, TypeScript, 64 direct derivations, 758 tests passed with 11 skips across
81 passing and two skipped files, clean build, packed installation, executable
help, and installed commit-policy/lifecycle smoke. Credentialed provider and
remote platform evidence retain the limits above.
