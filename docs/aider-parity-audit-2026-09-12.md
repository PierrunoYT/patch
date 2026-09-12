# Aider parity audit — 2026-09-12

## Scope and evidence boundary

This dated audit compares:

- Patch `bda2be474c298de73bd2dce9d7c17e7a38c1ccac`; and
- aider `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`.

Both repositories were clean at those revisions. The aider checkout remained the
external sibling `D:\Github\aider-upstream`; Patch neither copied it into the
repository nor used Python at runtime. This audit preserves the 2026-09-10 and
2026-09-11 reports as historical snapshots.

The review covered all 78 Phase 0–9 checkboxes as they stood at the Patch audit
revision: 73 checked and five unchecked. It traced checked claims through the
production composition root, package smoke scripts, focused integration tests,
CI definitions, and affected subsystem documentation. For open parity areas it
compared the pinned upstream implementation directly with Patch source. Existing
tests establish only the scenarios they exercise.

This was not a live-provider, real-device, or remote-CI audit. The local
validation recorded below used no provider credentials or provider API requests.
The protected provider workflow and provisioned PTY jobs remain separate
evidence.

## Verdict

Patch is a substantial partial port with a production-wired, deliberately
scoped terminal workflow. The audit found no Phase 0–9 checkbox that remained
checked solely because a helper, schema, or mock existed. It did find stale exit
and R-status wording that understated later production wiring, plus broad open
parity tasks that needed narrower acceptance boundaries.

The documented Patch core is implemented through the executable composition
root: configuration, supported providers and edit formats, serialized turns,
write authorization, Git/check/command effects, terminal input, watch, and the
local HTTP/SSE interface. This does **not** establish drop-in aider compatibility
or release readiness. Provider breadth, command breadth, prompt/UI fidelity, and
several recovery algorithms remain narrower.

There is no unchecked immediate P0 implementation item at this revision. The
next correctness work is the P1 list below; fresh release evidence is still
required before making a release claim.

## Phase-by-phase result

| Phase | Current result | Strongest evidence and remaining boundary |
| --- | --- | --- |
| 0 — foundation | Met for the documented package foundation | `npm run check` includes format, lint, typecheck, provenance, tests, a clean build, and packed-install smoke. CI defines Node 22 Linux checks plus Linux/macOS/Windows package jobs. The fixture exporter remains development-only and requires the external pinned checkout. |
| 1 — files/config/messages | Met for the documented Patch scope | The executable uses staged bootstrap, packaged model/prompt resources, current-file fence reselection, and safe filesystem adapters. Packed `/settings` runs establish YAML/environment/dotenv/CLI precedence. Patch deliberately guarantees only metadata Node can preserve portably; ACLs, extended attributes, flags, and alternate data streams are outside the contract. |
| 2 — edit engines | Met for selected formats, not all upstream recovery | The six constructed formats have independent pinned goldens and asymmetric malformed/ambiguity/partial-write/cancellation tests. Unified-diff recovery beyond exact unique line-anchored hunks remains a Phase 7 item. |
| 3 — conversation engine | Met for the documented Patch lifecycle | `ConcreteApplicationService` drives immutable attempt context, bounded retries/reflection, mutation-aware history, model/profile switching, weak-model summarization, and cleanup. Real-Git tests inject every named lifecycle boundary. Patch intentionally auto-reflects configured failures rather than asking aider's per-failure question; arbitrary child-command effects and interruption inside Git are not recoverable transactions. |
| 4 — providers | Partial parity; documented routes are production-wired | OpenAI, Anthropic, and the DeepSeek dialect are factory-reachable; executable fake-wire tests cover one-shot, retained multi-turn history, and malformed streams. Gated live OpenAI/Anthropic contracts cover streaming, usage, stop, cancellation, and native media/cache features. The DeepSeek live case still constructs its adapter directly, and history summarization lacks aider's input-window cap and weak-to-main fallback. Provider breadth remains intentionally smaller than LiteLLM. |
| 5 — Git/authorization/commands | Met for the supported Patch MVP workflow | The installed service smoke covers preview, checkpoint, edits, commits, lint reflection, approved commands, tests, and owned undo with exact Git state. Standalone terminal tests separately cover strict approval behavior. All 20 advertised command effects run in one real temporary repository. This is not aider command/default parity or protection from arbitrary approved command side effects. |
| 6 — repository maps | Partial | Eleven languages have exact tag samples and packed extraction. Production refreshes filtered tracked inventory and uses model-derived budgets with a strict fitted prefix. `TreeContextRenderer` is still a narrow approximation, production token fitting uses a four-character estimate, fallback map requests are absent, and personalization/lexical-fallback rendering lacks independent pinned and executable-provider evidence. |
| 7 — advanced modes | Partial | Internal editor, architect acceptance/handoff, context convergence, prompt-cache keepalive, repeated prefill, and bounded media are production-wired and tested through application sessions. Broader unified-diff indentation, omitted-line, partial-context, and duplicate-hunk recovery is absent. Advanced orchestration identities remain private rather than advertised CLI modes. |
| 8 — terminal | Met for the documented minimal terminal surface; rich-renderer parity deferred | Completion, recall, multiline input, external editor, optional PTY dispatch, notifications, output status, and the shared sanitizer are executable paths. The dependency-free renderer intentionally omits Rich tables, full list/wrapping behavior, unstable-tail rerendering, computed edit hunks, and Vi modal editing. Provisioned PTY CI covers Linux/Windows, not macOS. |
| 9 — optional interfaces | Met for documented adapters | `/web`, watch, authenticated loopback HTTP/SSE, bounded sessions/replay/backpressure, structured partial results, and shared-worktree serialization reach the concrete application. The optional voice subpath is library/embedding-only. Browser GUI and CLI voice UX are deferred; public or multi-tenant hosting is unsupported. |

## Highest-priority open correctness work

### P1. Bound history summarization and add model fallback

Pinned `aider/history.py:72–87` truncates the summary input to the summarizing
model's input window, reserving 512 tokens. Its `summarize_all` tries the weak
model and then the main model, configured in
`aider/coders/base_coder.py:510–513`.

Patch `src/core/chat-summary.ts:108–128` sends the complete selected head, and
`ConcreteApplicationSession.#summarize` constructs only the active weak model.
A long head can therefore exceed the weak model's window even though history
compaction was intended to recover the next turn. Add an explicit summarizer
input limit, weak-to-main fallback, cancellation and usage aggregation, and an
all-models-fail case that leaves completed history unchanged.

### P1. Complete repository-map rendering and fallback evidence

Pinned `aider/repomap.py` renders through generic `grep_ast.TreeContext` and
`aider/coders/base_coder.py:724–746` retries an empty hinted map first as a
global map and then without hints.

Patch `src/context/tree-context.ts` includes only selected lines plus recognized
parent declarations. `src/context/repo-map-renderer.ts` fits the largest entry
prefix, while the production composition root counts map text as one token per
four characters. Preserve the strict ceiling, but complete or deliberately
scope TreeContext behavior, decide tokenizer accuracy, implement the documented
fallback requests, and add pinned personalization/lexical-fallback plus actual
provider-turn evidence.

### P1. Complete unified-diff recovery

Pinned `aider/coders/udiff_coder.py:151–309` normalizes hunks, makes omitted
lines explicit, performs flexible indentation-aware replacement, and retries
partial hunks with progressively reduced context. It also deduplicates identical
path/hunk pairs before application.

Patch `src/edits/unified-diff.ts` intentionally requires one exact line-anchored
match and correctly preserves standard no-final-newline marker semantics, unlike
the pinned implementation. Retain that hardening while adding or explicitly
rejecting indentation, omitted-line, partial-context, and duplicate-hunk cases
with asymmetric pinned fixtures.

## Evidence and release follow-ups

- Exercise the advertised DeepSeek catalog model through catalog, factory, and
  session boundaries in the protected live contract, or narrow the Phase 4 live
  acceptance statement to the current direct-adapter evidence.
- Obtain a green Linux/macOS/Windows package run for the eventual release
  revision. The cited green run predates this audit revision.
- Run the provisioned PTY jobs and protected live-provider workflow for that
  revision when making their respective claims; default local validation cannot
  substitute for either.
- Keep computed edit-preview hunks, Rich-style rendering, Vi modal input, browser
  GUI, and CLI voice UX deferred unless product scope explicitly schedules them.
  Their absence does not invalidate the documented minimal terminal or optional
  adapter surface.

## Documentation reconciliation

This audit corrects the live plan and backlog rather than rewriting older audit
evidence. In particular:

- R1 is complete for its listed application-composition scope; advanced roles,
  provider lifetime, prompts, and interface policy are now production-wired.
- R2 and Phase 3 are complete for every named Patch lifecycle boundary, with
  explicit non-transactional limits rather than an unsupported exhaustive aider
  equivalence claim.
- Phase 5 is a working scoped MVP path; per-failure prompting is an intentional
  policy difference, not an unimplemented release prerequisite.
- R8 and Phase 9 have complete documented local-interface policy. Browser GUI,
  public hosting, and CLI voice remain outside that claim.
- Phase 8 is complete only for Patch's documented minimal terminal surface;
  richer renderer behavior is deferred parity.

## Local validation

On Windows with Node.js `v24.18.0`, the documentation-only audit change passed
`npm run check`: format, lint, typecheck, the 63-entry direct-derivation check,
659 tests passed with nine skipped, a clean build completed, and packed-install
smoke passed, including the installed lifecycle and executable help. A separate
`npm start -- --help` also passed.

This is local Node 24 evidence against the audit documentation commit, not Node
22 CI, protected live-provider, provisioned PTY, or real-device evidence. No
runtime source changed during this audit.
