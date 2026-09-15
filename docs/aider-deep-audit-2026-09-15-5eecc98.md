# Deep aider parity audit — 2026-09-15

## Boundary

This semantic audit compares clean committed trees before fixes at:

- Patch `5eecc980833e23e17ab119031ca679fc54d0301d`; and
- canonical aider `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`.

The aider checkout remained outside Patch at `../aider-upstream`, with the canonical origin and exact `upstream.json` revision. Unlike the preceding source-inventory audit, this pass compared branch behavior inside the owning modules: 43 upstream commands, 120 argument registrations, coder creation/switching, prompt chunk construction, all registered edit coders, model settings/metadata resolution, provider requests/events, Git and filesystem transitions, process cleanup, repository-map extraction/ranking/rendering/cache, watch/URL/web/voice adapters, packaging, and CI workflows.

## Verdict

Patch remains intentionally narrower than aider, but the selected product surface is substantially production-wired. The deeper pass found **seven supported-surface defects/hardening gaps** that the prior feature-level audit missed:

1. context selection disclosed a model-selected file when an embedding supplied no path approver;
2. cancellation was not forwarded into switch-time history summarization;
3. repository-map read paths did not retain the verified contained handle across ancestor swaps;
4. custom configuration, dotenv, and model resource files had entry-count bounds but no byte bound;
5. `systemRole: false` was declared but prompt construction still emitted system messages;
6. bundled aider prompt-placement settings (`examples_as_sys_msg` and reminder role) were not represented;
7. Windows model-command tree termination could settle after the direct child closed but before `taskkill /T /F` completed.

The same pass found one bounded-input omission: `/web` accepted an unbounded URL string. All eight findings are fixed in the accompanying implementation change and receive focused regression coverage.

No additional correctness defect was found in the selected whole-file, SEARCH/REPLACE, unified-diff, Patch-action, Git ownership, repository-map ranking, HTTP/SSE quota, watch, or voice-helper contracts. This is still not a claim of byte-for-byte prompt parity, every upstream test permutation, or support for explicitly rejected aider breadth.

## Semantic comparison by subsystem

### CLI and commands

Patch has 28 exact slash commands versus aider's 43 `cmd_*` methods, prefix matching, and `!` alias. Every Patch command reaches `ConcreteApplicationService` and remains synchronized with help/completion tests. Differences in aliases, bare `/read-only`, reset/mode shortcuts, `/git`, command files, editor aliases, map refresh/context copying, CLI voice, and semantic help are explicit non-goals. Deep review confirmed approval and serialization boundaries, but added a 4,096-character URL ceiling to `/web`.

### Coder lifecycle and prompts

Patch preserves chunk order and now reproduces pinned read-only/repository acknowledgement pairs. It forwards cancellation into switch-time summarization and fails the switch atomically. Context-selected paths now require an approver before their content can reach a subsequent pass; absence is denial, consistent with the documented model-selected disclosure boundary.

Model prompt construction now honors `systemRole: false`, `examplesAsSystem`, and `reminderRole`. Bundled GPT-4o, GPT-4o-mini, Claude, and DeepSeek profiles carry the pinned placement values. Patch prompts remain shorter, English-only, and contain Patch-specific authorization/ambiguity rules; byte-level prompt parity remains a non-goal.

### Edit formats

The six public formats remain `ask`, `whole`, `diff`, `diff-fenced`, `udiff`, and `patch`. Whole-file filename inference and priority match the pinned implementation. SEARCH/REPLACE preserves exact, indentation, leading-blank, and paired-ellipsis behavior while rejecting ambiguity and cross-file fallback. Unified diff implements physical-line fence scanning, standard no-final-newline semantics, validated insertion ranges, and bounded unique recovery; these intentionally differ from upstream's append/refusal and broader fuzzy behavior. Patch actions match add/delete/update/move and fuzz semantics with stronger conflict/overlap rejection. No new parser defect was found.

### Models, providers, and configuration

Patch intentionally supports OpenAI, Anthropic, and DeepSeek rather than LiteLLM breadth. The deeper pass confirmed request-field precedence, usage normalization, retry classification, DeepSeek dialect behavior, role selection, capability-gated reasoning/thinking, and selected bundled metadata. It fixed unused prompt-role capability/placement fields and added race-safe 1 MiB limits for configuration, dotenv, and custom model resources. Provider `extraParameters` remain an explicitly trusted custom-catalog escape within the selected adapter, not a user-facing network-provider expansion.

### Git, filesystem, and processes

Patch retains stronger literal pathspecs, composed ignores, selected commits, exact index restoration, CAS/session-owned undo, contained paths, hard-link refusal, ancestor identity checks, and atomic per-file replacement. Cross-file rollback, durable recovery, ACL/xattr/ADS preservation, and arbitrary hook/child rollback remain explicit limits. Model commands retain approval, root confinement, output/time bounds, and process-tree termination; Windows now waits for `taskkill /T /F` before reporting timeout/cancellation completion.

### Repository maps

The selected eleven language entries, lexical fallback, PageRank weighting, parent-header rendering, token fitting, fingerprinted cache, refresh behavior, and production fallbacks were compared with `aider/repomap.py` and pinned fixtures. Tag extraction and tree rendering now read through retained verified handles and reject deterministic ancestor swaps. Source parsing/rendering is capped at 4 MiB per file. Aider's broader query inventory, progress UI, public tuning, Pygments reference fallback, and universal ranking parity remain outside selected scope.

### Interfaces, package, and workflows

Patch's explicit URL fetch is DNS-pinned, public-address-only, redirect-revalidated, UTF-8/text-only, size/time bounded, and no-subresource; it is intentionally stricter than aider's HTTP/browser scraper. Watch reads are bounded/contained and use the shared application lifecycle. HTTP/SSE remains authenticated loopback-only with quotas, replay/backpressure, expiry, ownership, and partial-result redaction. Voice remains an optional embedding subpath. Package smoke proves runtime resources/docs, installed executable behavior, all map languages, optional voice import, and absence of default PTY/browser/audio dependencies. CI covers Node 22, Linux/macOS/Windows package contracts, and provisioned Linux/Windows PTY; current-revision remote and OpenAI/DeepSeek live evidence remain unavailable.

## Intentional differences retained

- no Python/aider runtime, Docker parity, analytics, onboarding/OAuth, updater, implicit provider metadata networking, or default transcript persistence;
- three named providers rather than LiteLLM breadth;
- exact commands rather than prefixes, aliases, command scripts, or compound reset semantics;
- six public edit formats; private architect/context/editor workflows and no `udiff-simple` prompt alias;
- ambiguity rejection, explicit write/path/command approval, selected disclosure, bounded processes/networking, and contained reads;
- composed Git policy and process-local recovery rather than independently disableable safety pieces or false transaction guarantees;
- eleven map entries and internal model-derived tuning;
- dependency-free streaming terminal, full-content previews, Ctrl-X Ctrl-E, and no Rich/Vi replacement;
- authenticated local API rather than browser GUI; embedding voice rather than CLI device UX.

## Evidence limits

This audit is deeper semantic source review plus focused executable regression tests, not mathematical proof of equivalence over all inputs. It did not run a new remote platform matrix, browser GUI, microphone/device path, or successful OpenAI/DeepSeek live call. Anthropic live evidence remains successful; available OpenAI credentials are rate-limited and no DeepSeek credential is available.

Local verification passed `npm run check` on Windows: formatting, ESLint,
TypeScript, 64 direct derivations, 769 tests with 11 skips across 81 passing and
two skipped files, clean build, packed installation, executable help, and
installed commit-policy/lifecycle smoke.
