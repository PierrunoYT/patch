# Aider parity audit — 2026-09-11

## Scope and evidence

Eight read-only subagent audits compared:

- Patch: `476d1657410bdd47982cc7fddb179ccf83d4a734`
- Aider: `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`

The parent agent verified both checkout revisions, reviewed the findings, and
reproduced several locally. The audits covered core lifecycle, edit formats,
models/providers, Git/filesystem, repository maps, commands/terminal, optional
interfaces, and configuration/package/fixture provenance.

Subagents performed source-only audits. The parent additionally reproduced the
prompt, parser, metadata, and cache-cost findings through direct calls to the
existing build. No live providers were called and no new full-suite run was
performed for this audit. Existing tests establish only the cases they exercise.
Source references and line numbers below refer to the audited revisions.

This report supplements the historical audit of Patch
`58597efc390e8e138b29024871a25d192fb27462` in
[the integration backlog](remaining-integration-tasks.md). It does not replace
that historical baseline, close implementation tasks, or establish release
readiness.

## Verdict

Patch is a **substantial partial port, not a drop-in aider replacement**. The
production path is much stronger than the old audit matrix suggests, but
important correctness, integration, and evidence gaps remain.

### Strong, production-wired areas

- Serialized turns, edit approval, checkpointing, reflection, and cancellation.
- Model/mode switching and weak-model history summarization.
- Six constructed edit formats: `ask`, `whole`, `diff`, `diff-fenced`, `udiff`,
  and `patch`.
- Literal Git pathspecs, containment checks, session-owned undo, and worktree
  locking.
- Repository maps with eleven-language **sample-level** tag parity.
- Terminal completion, multiline input, external editor, and explicit PTY
  dispatch.
- Bounded URL ingestion, watch mode, and authenticated local HTTP/SSE.

## Highest-priority findings

### 1. `.aiderignore` replaces global Git exclusions rather than composing with them

When `.aiderignore` exists, Patch overrides `core.excludesFile` for its ignore
check. Files excluded only by the user's global Git ignore policy may
consequently become eligible for selection/context.

This is an existing, documented production limitation, not resolved by the
completed tracked-ignore work. Upstream applies its aider-specific ignore
matching separately from ordinary Git ignore behavior.

**Evidence:** source-confirmed, not runtime-reproduced in this audit.

- Patch: [`src/repository/git.ts`](../src/repository/git.ts), lines 235–263.
- Upstream: `aider/repo.py`, lines 500–565.
- Existing limitation: [Git repository adapter](git-repository.md), lines 34–37.

### 2. Main bundled models lack input limits and pricing

Direct calls to the built catalog confirmed that `gpt-4o`, `gpt-4o-mini`,
`claude-sonnet-4-6`, and `claude-haiku-4-5` have:

- No bundled `maxInputTokens`.
- Unknown catalog cost.

Metadata merging works, but the supplied data is incomplete. That prevents
model-aware input-limit enforcement for those defaults.

Separately, changing `cachedInputTokens` does **not** change catalog-calculated
cost. Upstream distinguishes cache pricing. Provider-supplied cost, when present,
is a separate path and takes precedence over the catalog calculation.

**Evidence:** reproduced against the existing build for all four models and for
DeepSeek catalog cost with zero versus fully cached input tokens.

- Patch: [`src/resources/model-metadata.json5`](../src/resources/model-metadata.json5).
- Patch: [`src/resources/model-settings.yml`](../src/resources/model-settings.yml).
- Patch: [`src/models/usage.ts`](../src/models/usage.ts), lines 42–59.
- Upstream: `aider/resources/model-metadata.json` and
  `aider/coders/base_coder.py`, lines 1994–2100, for cache-token accounting.

### 3. The expanded fixture exporter has incomplete blob-hash coverage

The driver imports these modules, but they are absent from `fixtureSources`:

- `aider/coders/__init__.py`
- `aider/coders/udiff_coder.py`
- `aider/special.py`

**Important qualification:** ordinary modifications are still caught by the
clean-tree check. The gap is the stronger protection against changes hidden
from Git status, which is the reason for independently hashing on-disk sources.

This does **not** invalidate the reported byte-identical regeneration result.
It does mean the claim that every directly imported source is hash-checked is
currently too broad.

**Evidence:** source-confirmed by comparing the import list with the hash
manifest and exporter guard. No hidden-change experiment or fixture regeneration
was performed in this audit.

- Patch: [`upstream.json`](../upstream.json), lines 5–15.
- Patch: [`scripts/upstream-fixture-driver.py`](../scripts/upstream-fixture-driver.py),
  lines 434–445.
- Patch: [`scripts/export-upstream-fixtures.mjs`](../scripts/export-upstream-fixtures.mjs),
  lines 37–66.

### 4. Production commit policy remains hard-coded

The application passes `verify: false` and does not supply attribution.
Generated-message and configurable commit-policy capabilities remain
adapter-level rather than executable behavior.

This is a configuration/integration gap; it should not be mistaken for complete
Git-policy parity.

**Evidence:** source-confirmed production call path.

- Patch: [`src/core/concrete-application-service.ts`](../src/core/concrete-application-service.ts),
  lines 1176–1197.
- Patch: [`src/repository/git.ts`](../src/repository/git.ts), lines 287–351.
- Upstream: `aider/repo.py`, lines 131–318, and
  `aider/coders/base_coder.py`, lines 2375–2423.

### 5. `diff-fenced` is not actually a distinct prompt variant

Direct comparison reproduced that `diff` and `diff-fenced` receive identical
system prompts, examples, and reminders. Upstream teaches a distinct
filename-inside-fence layout.

The parser is constructed, but the checked "prompt variant" claim is
unsupported. A dedicated fenced reminder exists in Patch's prompt resources but
is not used by the strategy registry.

**Evidence:** reproduced against the existing build and checked against source.

- Patch: [`src/edits/registry.ts`](../src/edits/registry.ts), lines 57–76.
- Patch: [`src/resources/prompts.ts`](../src/resources/prompts.ts), lines 104–107.
- Upstream: `aider/coders/editblock_fenced_coder.py`, lines 1–10, and
  `aider/coders/editblock_fenced_prompts.py`, lines 1–143.

### 6. Unified-diff parsing rejects standard no-newline markers

The parser rejects:

```text
\ No newline at end of file
```

Upstream's parser tolerates these lines. This establishes a **parser-level
difference**, not proof that upstream correctly applies every no-newline case.

Patch also lacks upstream's broader hunk-recovery behavior; its deliberate
ambiguity rejection should remain intact. The separately pinned mid-block
`a/`/`b/` prefix-normalization difference is intentional and is not a defect.

**Evidence:** marker rejection reproduced against the existing build; upstream
parser tolerance and broader recovery compared from source.

- Patch: [`src/edits/unified-diff.ts`](../src/edits/unified-diff.ts), lines 138–145.
- Upstream: `aider/coders/udiff_coder.py`, lines 337–429, for parsing and
  before/after extraction; lines 151–309 for recovery behavior.

### 7. Literal bracket filenames are interpreted as globs

Selection checks for glob syntax before checking whether an exact file exists.
`/add [ab].txt` can therefore select `a.txt`/`b.txt` or fail instead of selecting
the literal `[ab].txt`.

Git's downstream literal-pathspec protection does not fix this earlier
selection problem. Upstream checks whether an exact file exists before
expanding the input as a glob.

**Evidence:** source-confirmed, not runtime-reproduced in this audit.

- Patch: [`src/io/selection.ts`](../src/io/selection.ts), lines 166–199.
- Upstream: `aider/commands.py`, lines 799–818.

### 8. HTTP errors discard structured partial-turn results

The session can throw `TurnPartiallyAppliedError` with changed paths and commit
information, but the HTTP boundary converts it into generic
`500 Request failed`.

Some progress may already be visible through events, but the error response
loses the structured recovery result. Preserve generic handling for unexpected
errors while deliberately exposing safe partial-result information to the
authenticated client.

**Evidence:** source-confirmed boundary behavior; no failing HTTP partial-turn
scenario was executed in this audit. Upstream's GUI exposes edit/commit state,
but it is not an HTTP/SSE API and has no directly equivalent response contract.

- Patch: [`src/interfaces/web-server.ts`](../src/interfaces/web-server.ts),
  lines 182–207.
- Patch: [`src/core/concrete-application-service.ts`](../src/core/concrete-application-service.ts),
  lines 680–689.
- Upstream comparison: `aider/gui.py`, lines 412–454.

## Significant remaining parity work

| Area | Current limitation |
| --- | --- |
| Advanced workflows | Architect/editor and context remain helper-only. |
| Media/cache | Image/PDF context construction and cache keepalive are not production-wired. |
| Summarization | No upstream-style main-model fallback or summarizer input-window cap. |
| Repository maps | Narrower mention matching, approximate token counting/rendering, and missing fallback requests. Empty-chat multiplier defaults to **8**, versus aider CLI's **2**. |
| Commands/config | Much narrower option and command surface; `/help`, `/settings`, and `/report` remain planned. |
| Optional interfaces | HTTP quotas, expiry, bounded backpressure, and session reclamation remain unfinished. |

The eleven-language fixtures verify the samples supplied, not arbitrary
programs, ranking equivalence, or full map parity.

Relevant production boundaries include:

- [`src/edits/registry.ts`](../src/edits/registry.ts), lines 32–96, for the six
  constructed formats.
- [`src/core/concrete-application-service.ts`](../src/core/concrete-application-service.ts),
  lines 1085–1117, for single-model summarization; lines 1157–1173 for the single
  map request; lines 170–181 for approximate map token counting.
- [`src/core/chat-summary.ts`](../src/core/chat-summary.ts), lines 108–128, for
  summary-request construction without a summarizer input-window cap.
- [`src/context/repository-map.ts`](../src/context/repository-map.ts), lines
  84–111, for the multiplier default and its context-window-dependent use.
- Upstream `aider/args.py`, lines 245–267, for the executable multiplier default;
  `aider/history.py` for input-window handling and model fallback;
  `aider/coders/base_coder.py`, lines 724–748, for fallback map requests.

## Intentional differences and excluded findings

Do not weaken containment, explicit path/command authorization, ambiguity
rejection, process bounds, or SSRF/no-subresource policy to mimic upstream.
Browser GUI and CLI voice UX remain deferred. Analytics, automatic
onboarding/OAuth, and built-in update/release-note flows are documented
non-goals, not accidental omissions.

The parent review excluded or narrowed weaker subagent claims:

- Disconnect cancellation is not simply absent: the POST handler passes an
  abort signal on response closure. Targeted runtime evidence is needed before
  calling that implementation broken.
- Missing historical Anthropic beta headers do not, by themselves, prove that
  current provider features are broken.
- Attempt-bounded retries are not "unbounded" merely because their bound
  differs from upstream's retry-delay policy.
- Separate full and application-only edit-format schemas do not, by themselves,
  constitute a bug; helper-only formats must simply not be advertised as
  executable modes.
- The older audit revision is valid historical evidence, not something to
  replace blindly with today's HEAD.

## Documentation reconciliation

Concrete stale claims include:

- Tracked inventory described as frozen, although production refreshes it.
- Directory expansion described as unimplemented, although it is wired.
- Fenced-diff prompt parity checked off despite shared prompts.

Sources include [Git repository adapter](git-repository.md),
[configuration bootstrap](configuration-bootstrap.md), and
[the porting plan](../PORTING_PLAN.md). The older audit revision should remain
as historical evidence; it should **not** simply be replaced everywhere with
the newly audited HEAD.

## Verification and recommended next step

- Subagents performed source-only audits.
- The parent additionally reproduced the prompt, parser, metadata, and cache-cost
  findings against the existing build.
- The earlier full run was **471 passed, 4 skipped, 2 Windows filesystem
  failures**. Formatting, lint, typecheck, build, package smoke, and CLI help
  passed. The failing cases were the ancestor-swap test receiving `EPERM` and
  the permission test expecting `0600` but receiving `0666`.
- No new full-suite or live-provider run was performed for this audit.
- No source files were modified, and no fixes were applied during the audit.
  Saving this report is a documentation-only follow-up.

Prioritize **ignore-policy composition, model metadata/accounting, fixture hash
coverage, and the concrete edit/selection defects before `/help`**. Those affect
existing behavior and confidence in its evidence, rather than adding another
command.
