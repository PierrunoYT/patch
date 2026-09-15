# Aider parity audit — 2026-09-15 (`cee39ed`)

## Reproducible boundary

This immutable snapshot compares clean source trees at:

- Patch `cee39ed41330eca755b9c7c65084abccefce90aa`; and
- canonical aider `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`.

The canonical checkout was clean, had the expected origin, and remained outside
Patch at `../aider-upstream`. Six independent streams reviewed lifecycle/edits;
models/providers/configuration; Git/filesystem/processes; CLI/commands/terminal;
maps/interfaces; and inventory/package/documentation. The companion
[source inventory](aider-source-inventory-2026-09-15-cee39ed.md) preserves the
complete 80-module, two-model-file, 58-query, and 36-executable-test manifest.
Its corrected upstream workflow count is ten. Inventory completeness is not
semantic parity.

## Verdict

Patch remains a substantial, production-wired partial port, not a 1:1 aider
replacement. This pass found the following supported-scope defects and evidence
gaps. No new defect was found in the other inspected selected contracts,
including provider prompt placement and retry lifecycle, selected edit recovery,
Git ownership, contained map extraction, command dispatch, terminal sanitation,
watch lifecycle, and package runtime smoke. That statement is bounded to the
contracts and cases inspected, not a general parity claim.

## Findings

### P1 — PATCH-2: Patch output is not sentinel-closed

`PatchEditStrategy.parse()` starts at line zero when `*** Begin Patch` is absent
and returns successfully at end-of-input when `*** End Patch` is absent
(`src/edits/patch.ts:222-232`). Focused probes also accepted successfully
truncated action output. This tolerance is inherited from pinned
`aider/coders/patch_coder.py:229-254,300-307,404-410`, which explicitly permits
missing sentinels, but conflicts with Patch's fail-closed malformed-output
posture. Require both envelope sentinels and reject truncation.

### P1 — MODEL-8: history budgets ignore model context size

`src/models/settings.ts:43-44` defaults `maxChatHistoryTokens` to 1,024, and none
of the six entries in `src/resources/model-settings.yml:5-90` overrides it.
Pinned `aider/models.py:355-358` derives
`min(max(max_input_tokens / 16, 1024), 8192)`: 128k profiles therefore receive
8,000 and 200k profiles receive 8,192. Patch summarizes substantially earlier
than the pinned model policy.

### P1 — TOKEN-1: “conservative” fallback can undercount

For non-OpenAI models, unknown OpenAI models, and multimodal messages, token
counting falls back to JavaScript UTF-16 string or JSON length divided by four
(`src/models/token-count.ts:17-29,55-65,68-88,102-110`) while labelling the result
`conservative`. A focused reproduction counted 128,000 CJK characters as only
32,000 tokens. Prompt preflight can consequently admit input larger than the
provider context. Use a genuinely upper-bounding fallback or rename and add a
separate safe refusal bound.

### P1 — FS-2: general text reads are unbounded and lose containment

`FileSystemAdapter.readText()` resolves a path and then calls pathname-based
`readFile()` with no byte cap (`src/io/filesystem.ts:298-310`). It retains
neither an opened-handle/ancestor identity guarantee nor a size bound. Production
file snapshots and startup/application reads reach this method, including
`src/core/concrete-application-service.ts:422` and edit transaction reads at
`src/edits/transaction.ts:22`; static resolution alone does not close an
ancestor-swap window.

### P1 — MAP-5: cache hashing bypasses the extractor bound

`RepoMapTagCache.tags()` opens safely but reads and hashes the entire source
before consulting its source adapter (`src/context/tag-cache.ts:126-137`). Only
later does `TagExtractor.extract()` enforce its 4 MiB limit
(`src/context/tag-extractor.ts:117-129`). An oversized tracked file therefore
consumes unbounded memory and hashing work before being rejected.

### P1 — PROC-3 and P2 — PROC-4: interactive process bounds

The PTY data callback appends every sanitized chunk to one string and returns it
(`src/process/pty.ts:122-148`) without a transcript byte cap: **PROC-3 (P1)**.
External-editor execution waits indefinitely for child close and then reads the
entire draft (`src/io/editor.ts:42-71`): **PROC-4 (P2)**. An editor is
intentionally interactive, so elapsed user editing time need not receive a
short command timeout; cancellation/termination still needs a bounded policy,
and the edited-file read needs an independent memory bound.

### P1 — WEB-3: session quota reservation is racy

Session creation checks global and principal counts, awaits asynchronous
`service.createSession()`, and only then inserts the session
(`src/interfaces/web-server.ts:211-248`). Concurrent requests can all pass the
same pre-await check and exceed both quotas. Reserve capacity synchronously
before the await and release it on every failure/close path.

### P1 — WEB-4: nested discarded HTML leaks content

The HTML converter tracks only one discarded tag name and clears it on the first
matching close (`src/interfaces/html-text.ts:158,194-209,234-245`). The focused
input `<script><script></script>LEAK</script><p>safe</p>` reproduced
`LEAK\n\nsafe`. Track nesting (including mixed discarded elements) so script and
style descendants cannot become readable prompt text.

### P1 — VOICE-2: active ffmpeg cancellation is not bounded

The pre-aborted-signal defect is fixed at `src/interfaces/voice.ts:178-183`, but
active abort only sends `SIGTERM` and the promise settles only on child `close`
(`src/interfaces/voice.ts:208-229`). An ffmpeg process that ignores SIGTERM can
leave cancellation waiting forever. Add a grace deadline and forceful cleanup.

### P2 — DOC-1: `/help` persistence claim conflicts with input history

`docs/commands.md:31-38` says help text is not added to chat history. However,
the generic input loop records every submitted input before dispatch and every
string response afterward (`src/input.ts:348-358`), wired to the opt-in input
and chat recorders at `src/program.ts:812-814`. Thus slash-command input and
responses can be persisted. This is a policy/documentation mismatch pending a
deliberate choice about command-recording semantics, not necessarily a code
defect.

### P2 — EVIDENCE-4: CI and package assertions omit provenance edges

`npm run check` includes `provenance:check` (`package.json:32,39`), but ordinary
CI manually expands formatting, lint, typecheck, test, build, and package smoke
without that step (`.github/workflows/ci.yml`). Package smoke exercises the
installed executable/resources but does not assert declaration-file presence or
resolve/import the root public package export. These are evidence gaps, not
observed package runtime failures.

## Intentional differences and non-goals

This review found no reason to weaken Patch's ambiguity rejection, explicit
approval for model-suggested commands and new/out-of-chat writes, literal Git
paths and session-owned undo, atomic per-file replacement, explicit providers
and allowlisted credentials, or DNS-pinned bounded URL fetching. Deliberate
breadth exclusions remain Rich/Vi UI, browser GUI, CLI/device voice UX, implicit
URL/subresource loading, analytics/onboarding/updater behavior, Python/Docker
distribution parity, broad LiteLLM providers, and aider's full command/query
surface. Those choices do not excuse defects inside the selected contracts.

## Verification and limits

Streams ran focused tests and reproductions against their areas. Their reported
suite totals overlap and were totaled independently; they must not be summed as
unique tests. The completed Linux/Node.js `v26.5.1` `npm run check` passed:
formatting, lint, typechecking, 64 direct derivations, 770 tests with ten skips
across 81 passing and two skipped files, clean build, packed installation,
installed commit-policy/lifecycle smoke, and executable help. This is not Node
22 or remote-platform evidence. The audit did not run credentialed provider
calls, real PTY/editor/ffmpeg resistance, microphone/device flows, browser GUI,
macOS, or Windows. Concurrency and ancestor-swap findings are source-traced; the
HTML and CJK cases were directly reproduced. Existing deterministic and package
tests remain evidence only for the cases they exercise.
