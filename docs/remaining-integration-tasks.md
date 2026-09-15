# Remaining integration tasks

This is the detailed implementation and evidence backlog, not a frozen audit
report. The root [issue and task register](../task.md) combines its unresolved
work with the latest audit findings into a deduplicated actionable queue. Keep
both current when status changes; this file preserves historical findings,
completed work, revision-specific evidence, and implementation context.

The current [parity audit](aider-parity-audit-2026-09-15-cee39ed.md)
compares Patch `cee39ed41330eca755b9c7c65084abccefce90aa` with canonical aider
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`. Its companion
[source inventory](aider-source-inventory-2026-09-15-cee39ed.md) classifies all
80 Python product modules, both model files, and all 58 queries. Earlier reports
remain historical snapshots; this backlog is live status.

This backlog distinguishes tested components from features that work through
the installed `patch` executable. Completing an isolated adapter or parser is
not enough to check a task or phase exit in `PORTING_PLAN.md`.

## Completion rules

Apply these rules to every section below:

- [ ] Preserve the pinned Aider baseline and document intentional differences.
- [ ] Add failure, cancellation, malformed-input, and path-containment tests at
      every boundary that accepts untrusted input.
- [ ] Use temporary real Git repositories for repository behavior and
      deterministic providers for ordinary session tests.
- [ ] Keep live credentials out of the default test suite and diagnostics.
- [ ] Run the narrowest relevant test while developing, then run all verification
      commands listed at the end before completing a milestone.
- [ ] Update `README.md`, `CHANGELOG.md`, affected feature documentation, and
      `PORTING_PLAN.md` in the same change as completed behavior.
- [ ] Mark a `PORTING_PLAN.md` checkbox complete only when its documented user
      path works. Uncheck or qualify every checkbox and exit claim currently
      supported only by an isolated module, mock, or schema entry.

## Required implementation order

```text
R0 native footprint
  └─▶ R1 application composition root
        ├─▶ R2 end-to-end turn lifecycle
        │     └─▶ R3 slash-command dispatch
        ├─▶ R4 live provider contracts
        ├─▶ R5 cross-platform CI
        ├─▶ R6 advanced modes
        ├─▶ R7 rich terminal integration
        └─▶ R8 optional interface exposure
                └─▶ R9 documentation truth pass
```

R9 should also be applied incrementally after each milestone; its final pass
depends on all earlier scope decisions being settled.

## Pinned Aider parity audits and current status

Six independent streams compared commands, lifecycle, prompts, edit coders,
models/providers/configuration, Git/filesystem/processes, repository maps,
interfaces, packaging, tests, and workflows. The current pass found nine P1
implementation gaps and three P2 policy/evidence gaps inside selected Patch
behavior. They are listed below; external OpenAI/DeepSeek live evidence also
remains unavailable.

### Current parity matrix

This matrix reflects the audit boundary `cee39ed`; historical audits retain their own state.

| Area                             | Current classification                                   | Strongest evidence boundary                                                                                                                                                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core lifecycle                   | implemented selected scope with explicit recovery limits | Immutable attempt context, queued cancellation, bounded retry/reflection, observer-atomic attempts, weak/main history summaries, cancellable atomic profile switching, private architect/editor/context workflows, and process-local worktree serialization are production-wired.               |
| Editing                          | implemented selected scope with intentional hardening    | Six public formats are wired with bounded ambiguity rejection. Patch actions require both envelope sentinels and reflect truncated output rather than applying a partial batch.                                                   |
| Models/providers                 | partial aider breadth; open budget/counting gaps          | Three providers and six profiles are wired; fixed 1,024-token history thresholds and a potentially undercounting fallback diverge from pinned/safe budget behavior. Live OpenAI/DeepSeek evidence remains external.          |
| Git/filesystem                   | implemented selected scope with documented limits        | General text, media, watch, and map reads retain verified handles and enforce byte ceilings. Git ownership and atomic writes are hardened; cross-file/durable recovery and portable metadata preservation remain explicit limits. |
| Repository maps                  | implemented selected scope; partial aider breadth        | Eleven languages, ranking/rendering, retained-handle extraction, bounded incremental cache hashing, and fitting are wired. Broader query/tuning breadth remains a non-goal.                                                     |
| Commands/terminal                | selected scope; open PTY/editor bounds                    | All 28 commands dispatch, and captured commands/clipboard are bounded. PTY transcript capture and editor readback are not; opt-in transcripts intentionally include slash commands and returned text.                         |
| Watch/URL/web/voice/help         | selected scope; open interface gaps                       | Watch and bounded URL transport are wired, but nested discarded HTML can leak content, async session creation can exceed quotas, and active ffmpeg abort lacks forced settlement. GUI/device UX remain non-goals.             |
| Configuration/package/provenance | selected scope; partial evidence                          | Config resources and runtime packaging are wired. Ordinary CI omits the provenance check, and package smoke does not assert declarations or resolve the root public export. Broader aider/Python/Docker breadth remains a non-goal. |

### Current audit findings — `cee39ed` — 2026-09-15

- [x] **P1 / PATCH-2 — reject missing Patch sentinels and truncated output.**
      Completed with strict first/last meaningful sentinels, parser/session
      regressions, and packed installed lifecycle evidence that the truncated
      attempt writes nothing before a complete reflected response.
- [ ] **P1 / MODEL-8 — derive history limits from model input windows.**
- [ ] **P1 / TOKEN-1 — replace or safely bound the undercounting fallback.**
- [x] **P1 / FS-2 — retain containment and cap general text reads.** Completed
      with retained-handle chunked reads capped at 4 MiB, including write
      preparation, deterministic ancestor-swap rejection, and oversized-file
      tests through `FileSystemAdapter` and transaction/application consumers.
- [x] **P1 / MAP-5 — enforce 4 MiB before tag-cache hashing.** Completed with
      one exported source ceiling, a retained-handle size check, incremental
      bounded SHA-256, growth detection, and production map coverage that skips
      extraction while retaining the tracked filename.
- [ ] **P1 / PROC-3 — cap retained PTY transcript output.**
- [ ] **P1 / WEB-3 — reserve concurrent session quota atomically.**
- [ ] **P1 / WEB-4 — handle nested discarded HTML elements.**
- [ ] **P1 / VOICE-3 — force-settle active ffmpeg cancellation.**
- [ ] **P2 / PROC-4 — bound editor readback and define cancellation.**
- [x] **P2 / DOC-1 — document slash-command transcript persistence.**
- [ ] **P2 / EVIDENCE-4 — add provenance and public export/type package checks.**

Exact failure sequences and source comparisons are in the current
[parity audit](aider-parity-audit-2026-09-15-cee39ed.md). The source inventory
also corrects the pinned upstream workflow count from nine to ten.

Local Linux/Node.js `v26.5.1` verification passed `npm run check`: formatting,
lint, typechecking, 64 direct derivations, 770 tests with ten skips, clean build,
packed installation, installed commit-policy/lifecycle smoke, and executable
help. This is not new Node 22, remote-platform, or credentialed-provider evidence.

### Deep semantic re-audit fixes — 2026-09-15

- [x] **P1 — Fail closed on context-selected disclosure without an approver.**
      A model-selected file can reach a later context pass only after explicit path
      approval; absent callback now denies before content disclosure.
- [x] **P1 — Carry cancellation through switch-time summarization.** Model/mode
      and reasoning/thinking switches pass their queued signal into weak/main
      summary calls and preserve the previous profile/history on cancellation.
- [x] **P1 — Retain containment and bounds for repository-map reads.** Tag
      extraction and tree rendering consume verified handles, reject ancestor swaps,
      and skip source above 4 MiB.
- [x] **P1 — Bound startup configuration resources.** Config, dotenv, and custom
      model documents use retained-handle 1 MiB reads before parsing.
- [x] **P1 — Honor prompt placement capabilities.** No-system preambles,
      examples-as-system, reminder roles, and pinned read-only/repository assistant
      acknowledgements now reach production requests.
- [x] **P1 — Await Windows command-tree termination.** Timeout/cancellation
      waits for `taskkill /T /F`, preventing descendants from outliving completion.
- [x] **P2 — Bound `/web` URL input.** The command rejects more than 4,096
      characters before URL parsing/network dispatch.

### File-for-file re-audit additions — 2026-09-15

Current evidence is in the
[deep audit](aider-deep-audit-2026-09-15-5eecc98.md), file-for-file
[audit](aider-parity-audit-2026-09-15-c9c59c6.md), and
[source inventory](aider-source-inventory-2026-09-15-c9c59c6.md).

- [x] **P1 — Do not expose output from a failed provider attempt as accepted
      turn output.** **Status:** fixed 2026-09-15. `CoderSession` buffers every
      validated event per provider attempt and publishes the ordered buffer only
      after an accepted finish. Retry reset discards partial text, reasoning, usage,
      and error events while preserving billed-cost accounting. Focused session and
      concrete-application tests prove result and production-interface observers
      contain only the successful attempt. Pinned aider has the same display
      weakness at `aider/coders/base_coder.py:1457-1488,1783-1791,1954-1972`; Patch
      intentionally trades token-by-token display latency for a consistent
      structured event API.
- [x] **P1 — Correct advertised model defaults.** **Status:** fixed 2026-09-15.
      `gpt-4o-mini` uses pinned `whole`/no-map defaults, and DeepSeek Reasoner routes
      both weak history summaries and editor work to DeepSeek Chat. Exact catalog
      and role-selection tests cover the resource contract; a concrete application
      test exercises both secondary providers through production session paths.
      Evidence: `src/resources/model-settings.yml`, `tests/model-catalog.test.ts`,
      `tests/model-selection.test.ts`, `tests/application-editor.test.ts`, and pinned
      `aider/resources/model-settings.yml:85-88,582-592`.
- [x] **P1 — Reconcile advertised DeepSeek token limits with pinned metadata.**
      **Status:** fixed 2026-09-15. Both profiles use the pinned 128,000 input
      limit; Chat uses 8,192 output tokens and Reasoner uses 64,000. Exact resolved
      catalog assertions cover budgeting/map inputs, and concrete application
      requests prove each output ceiling reaches the DeepSeek transport. Evidence:
      `src/resources/model-metadata.json5`, `src/resources/model-settings.yml`,
      `tests/model-metadata-merge.test.ts`, `tests/deepseek-provider.test.ts`, and
      pinned `aider/resources/model-metadata.json:2-32`.
- [x] **P1 — Bound and cancel clipboard utilities.** **Status:** fixed
      2026-09-15. The argv integration runner defaults to 10 seconds and 1 MiB,
      drains bounded stdout, forwards cancellation, terminates the child process
      tree, and settles after direct-child stdio closes. Clipboard writes reject
      oversized input before spawn and injected runners receive the same limits.
      Executable timeout/cancellation/overflow/cleanup tests and a cancelled-paste
      queue-reuse test cover the production signal path. Pinned aider remains
      unbounded; this is intentional Patch hardening.
- [x] **P1 — Preserve Windows backslashes in editor commands.** **Status:** fixed
      2026-09-15 with the slash-path defect below. `splitEditorCommand` and path
      commands now use one quote-aware splitter. It preserves drive, UNC, relative,
      quoted-space, and trailing separators while retaining POSIX whitespace, quote,
      and literal-backslash escapes. Focused editor-command tests cover every form.
- [x] **P1 — Retain containment across media and watch reads.** **Status:** fixed
      2026-09-15. `SafePathResolver.openFileForRead` opens canonical paths with
      no-follow semantics, then re-resolves the request, compares handle/path
      identity, and verifies every in-root ancestor before returning the retained
      handle. Media and watch consume bytes only through it. Deterministic pre-open
      ancestor swaps make media fail and watch submit nothing. Pinned aider is not
      stronger, so this is intentional hardening rather than compatibility mimicry.
- [x] **P2 — Make `FfmpegVoiceRecorder` honor a pre-aborted signal directly.**
      **Status:** fixed 2026-09-15. The exported adapter checks before constructing
      a child; a deterministic process test proves no side effect or listener.
      CLI/device voice is now an explicit non-goal, not deferred work.
- [x] **N/A — Keep exact command names and arguments.** Pinned aider maps `!`
      to `/run` and converts every editable file on bare `/read-only`. Patch keeps
      leading `!` as model input and requires explicit paths; aliases and compound
      state changes are current-release non-goals.
- [x] **N/A — Keep implicit OpenRouter metadata fetch/cache out of startup.**
      **Status:** intentional difference tied to unsupported provider breadth.
      Pinned `aider/openrouter.py:29-128` downloads a model list and writes a 24-hour
      home-directory cache. Patch may add explicit OpenRouter support later, but
      implicit startup networking/persistence remains outside its privacy policy.
- [x] **P2 — Normalize close-only reasoning before observer publication.**
      **Status:** fixed 2026-09-15. A complete tagged stream is split incrementally.
      When the opening tag predates the received stream, attempt-atomic buffering
      now reclassifies the prefix as one reasoning event and publishes only the
      answer as text. The result, continued-output prefix, history, and parser use
      that same answer. Focused tests split the close across provider deltas and
      cover an assistant-prefill continuation. Pinned aider strips the prefix only
      from its final response; Patch's structured observer contract is stronger.

Local documentation-change validation on Linux/Node.js `v26.5.1` passed
`npm run check`: 63 direct derivations, 685 tests passed with eight skips, a
clean build, packed installation, installed commit-policy/lifecycle smoke, and
executable help. A separate source-manifest check found all 80 product modules,
both model files, and all 58 queries in the inventory. This is not Node 22 CI,
credentialed provider, provisioned PTY, macOS/Windows, or real-device evidence.

### Repository-wide parity inventory -- 2026-09-14

This pass compared clean checkouts of Patch
`e10467b3dc787bb78bb2528339e52f4aa36c95bf` and canonical aider
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`. It inventoried product source,
tests, CLI and command registration, provider/model resources, edit strategies
and prompts, configuration, session/orchestration, repository/Git behavior,
IO and optional interfaces, lint/test execution, packaging, workflows, and
current documentation. Generated, vendor, build, cache, benchmark-output, and
historical website metadata were excluded except where package or documented
runtime behavior depended on them.

Status meanings in this section:

- **defect**: Patch's supported surface produces incorrect behavior and needs a
  fix.
- **partial**: useful implementation exists, but an Aider capability or its
  production path is incomplete.
- **unported**: Aider behavior has no Patch production implementation.
- **deferred**: potentially wanted work that requires scheduling or a product
  scope decision.
- **intentional difference**: Patch deliberately uses different behavior,
  usually for safety, boundedness, privacy, or a smaller product contract.
- **non-goal**: the absence is an accepted product decision, so it is not an
  implementation task unless that decision changes.

#### Verified defects and documentation corrections

- [x] **P0 -- Preserve added Markdown fences inside unified-diff hunks.**
      **Status:** fixed. Fence discovery now follows pinned aider's physical-line
      scan, so added, removed, and context Markdown fences remain prefixed hunk data
      and only an unprefixed line closes the response block. Focused parser/
      resolution tests and packed actual-bin smoke cover all three operations.
- [x] **P0 -- Apply insertion-only unified-diff hunks at their intended
      location or fail closed.** **Status:** fixed with intentional hardening. Patch
      retains numeric hunk ranges for empty-preimage edits, validates their counts
      and cumulative offsets from prior ranged insertions, and bounds the declared
      target against the current snapshot. A preceding content-located hunk makes a
      later context-free location unvalidated. Missing, inconsistent, and
      out-of-file ranges fail closed. Focused tests cover beginning, middle, end,
      repeated insertion text, new files, and existing empty files; packed
      actual-bin smoke covers a middle insertion. Pinned aider instead refuses every
      empty preimage.
- [x] **P1 -- Preserve Windows backslashes in slash-command paths.**
      **Status:** fixed 2026-09-15 with the editor-command defect above. `/add`,
      `/attach`, `/drop`, and `/read-only` use the shared quote-aware splitter.
      Parser cases cover absolute drive, UNC, relative, quoted-space, trailing-root,
      escaped-whitespace, escaped-quote, and literal-backslash forms. Aider's
      `aider/commands.py:799-805,912-925,1328-1416,1694-1697` also preserves
      backslashes while separating quoted names.
- [x] **P2 -- Retain the language identifier for quadruple Markdown fences.**
      **Status:** fixed 2026-09-15. `MarkdownStream` records the full opening
      backtick-run length and language, keeps shorter runs as code, and closes only
      on a bare run at least as long as the opening. Focused tests split both
      four-backtick delimiters across provider chunks and prove TypeScript
      highlighting plus shorter-run retention. Pinned aider delegates this behavior
      to Rich Markdown at `aider/mdstream.py:81-139`; Patch retains its bounded,
      dependency-free line renderer.
- [x] **P1 -- Remove or implement the documented Git-backed `/diff`
      operation.** **Status:** implemented 2026-09-15. `/diff` is a typed, serialized
      production effect that displays current staged and unstaged changes only for
      selected editable files. It uses the repository adapter's literal pathspecs,
      disables external diff and textconv helpers, strips terminal/bidirectional
      controls, caps complete UTF-8 output at 1 MiB, and reports missing Git,
      missing selection, and no-change states. Focused
      tests prove wildcard-like names stay literal, unselected content is absent,
      hostile controls are removed, multibyte truncation is valid, and no provider
      or approval hook runs; package smoke drives the installed bin in a real Git
      repository. Pinned aider's `commands.py:657-689` instead compares commits
      recorded around the last message. Patch intentionally retains current
      selected-file disclosure rather than adding repository-wide commit history.
      Local Linux/Node.js `v26.5.1` `npm run check` passed formatting, lint,
      typechecking, 63-entry provenance, 753 tests with ten skips, build, and packed
      installation including the new actual-bin command. This is not new Node 22,
      macOS, or Windows evidence.

The first three defects were reproduced against the built Patch package and
compared with executable calls into the pinned Aider checkout. The renderer
case was reproduced through built `MarkdownStream`. These tasks supersede the
broader checked unified-diff recovery claims below; those checked items remain
valid only for the specific normalization and recovery cases they name.

#### Models, providers, and model controls

- [x] **P1 -- Route live OpenAI and Anthropic contracts through catalog,
      factory, and application session boundaries.** **Status:** implemented and
      gated. `tests/live-provider.test.ts` retains the direct adapter capability,
      timeout, and cancellation contracts and adds one bounded turn per advertised
      provider through `ModelCatalog`, `createProvider`, and
      `ConcreteApplicationService`. OpenAI, Anthropic, and DeepSeek share the same
      16-output-token application-path helper. Aider's requests route through the
      model abstraction and LiteLLM in `aider/models.py:249-260` and
      `aider/llm.py:21-45`. Successful credentialed evidence remains a separate P2
      item because neither the audit orb nor the protected GitHub environment
      currently supplies provider secrets.
- [x] **N/A -- Keep the current release provider boundary to OpenAI, Anthropic,
      and DeepSeek.** **Status:** accepted scope. Patch explicitly rejects every
      other provider in `src/providers/factory.ts:50-60`; Aider accepts LiteLLM's
      provider inventory through `aider/llm.py:21-45` and documents/configures
      Azure, OpenRouter, Gemini/Vertex, Bedrock, Cohere, Groq, Ollama/LM Studio, xAI,
      and other OpenAI-compatible routes through `aider/args.py:67-112` and
      `aider/models.py:21-260`. Patch will not infer support from wire similarity or
      add an unbounded generic compatibility claim. Reopen expansion only for a
      named provider with an explicit credential, endpoint and capability contract,
      deterministic transport/application tests, documentation, and opt-in live
      evidence. OpenRouter's implicit metadata fetch/cache remains a privacy
      non-goal unless OpenRouter itself is selected.
- [x] **P2 -- Expose safe executable model discovery and custom catalog
      overlays.** **Status:** implemented for Patch's selected providers.
      `ModelCatalog` eagerly validates bounded alias/settings/metadata overlays;
      bootstrap exposes repeatable CLI, singular environment, and YAML-list inputs
      with CLI-over-environment-over-YAML precedence and invocation-directory path
      resolution. `--list-models [query]` and `/models [query]` render only bounded
      canonical model/provider/edit-format summaries without a provider or network
      call. Installed-bin, bootstrap, parser, application, and malformed-resource
      tests cover the production path. Custom catalog data does not add provider
      support beyond OpenAI, Anthropic, and DeepSeek. This is the strict local-file
      subset of Aider's model search and resource controls at
      `aider/args.py:113-137,207-228` and `aider/commands.py:205-217`.
- [x] **P2 -- Add reasoning-effort and thinking-token controls for models that
      declare support.** **Status:** implemented as a strict provider-scoped
      subset. Startup CLI/environment/YAML and `/reasoning-effort` and
      `/think-tokens` validate bounded typed values. Model settings must explicitly
      declare the matching capability; only OpenAI reasoning effort and Anthropic
      thinking budgets map to transport fields, and enabling either removes
      temperature. Atomic command changes, unsupported combinations, adapter request
      bodies, and startup precedence are tested. No bundled model claims a mutable
      capability that its current endpoint does not provide. This ports the safe
      subset of `aider/args.py:139-150,212-218`, `aider/models.py:792-923`, and
      `aider/commands.py:1580-1637` without LiteLLM/OpenRouter passthrough.
- [x] **P2 -- Expose independent main, weak, and editor model selection and
      switching.** **Status:** implemented. Staged CLI/environment/YAML selects
      weak/editor roles and editor format; `/weak-model` and `/editor-model` inspect
      or replace roles after bounded catalog resolution and editor-format
      validation. Serialized secondary changes leave the main provider/profile,
      compatible history, and media untouched. Summaries and generated commit
      messages use the current weak role; fresh isolated architect handoff uses the
      current editor, with usage transferred into main session accounting. Main
      `/model` retains its existing atomic provider construction/switch/cleanup.
      Focused bootstrap, parser, and production application tests cover the subset
      of `aider/args.py:185-205` and `aider/commands.py:87-136`.
- [x] **N/A -- Keep arbitrary API-key injection and disabled TLS verification
      out of the default Patch surface.** **Status:** intentional difference.
      Aider accepts `--set-env`, generic `--api-key`, and `--no-verify-ssl` at
      `aider/args.py:67-112,152-161`; Patch resolves allowlisted provider credentials
      from a private environment snapshot and uses verified TLS. Revisit only with
      a concrete private-endpoint requirement and secret-safe tests.
- [x] **N/A -- Keep explicit model selection as the startup default.**
      **Status:** intentional difference. Patch refuses startup without `--model`,
      `PATCH_MODEL`, or configured `model` at
      `src/core/concrete-application-service.ts:2035-2044`; Aider defaults to
      `gpt-4o` at `aider/models.py:28-31`. Explicit selection avoids silently
      choosing a billable provider and remains the accepted Patch policy.
- [x] **P3 -- Expose prompt-cache enablement separately from keepalive.**
      **Status:** implemented. Aider exposes `--cache-prompts` and
      `--cache-keepalive-pings` at `aider/args.py:230-243`; Patch now exposes paired
      `--cache-prompts`/`--no-cache-prompts` controls with `PATCH_CACHE_PROMPTS` and
      `cache-prompts` YAML precedence. Unlike aider's false default, Patch retains
      its existing capability-gated foreground markers by default; users can now
      disable those markers without changing model metadata, and disabling them
      suppresses any positive keepalive setting. Bootstrap, `CoderSession`, and
      concrete application tests prove precedence, request marker removal, and that
      no background refresh is made.

#### Edit strategies, prompts, and orchestration

- [x] **N/A -- Keep `udiff-simple` out of the public format set.** **Status:**
      accepted non-goal. Patch exposes exactly `ask`, `whole`, `diff`,
      `diff-fenced`, `udiff`, and `patch`. Pinned aider's
      `UnifiedDiffSimpleCoder` at `aider/coders/udiff_simple.py:5-18` inherits the
      ordinary unified-diff parser and changes only prompt wording, removing
      examples and detailed diff guidance in `udiff_simple_prompts.py:4-24`.
      Patch keeps one bounded, tested `udiff` protocol instead of adding a second
      schema value with identical parsing semantics. Function-call coder files
      remain excluded because pinned aider does not register them in `__all__`.
- [x] **N/A -- Keep architect and context as embedding-only workflows.**
      **Status:** accepted current-release scope. Patch exposes
      `ApplicationSession.runArchitect` and `selectContext` with explicit plan/path
      approval, bounded convergence, cancellation, atomic parent-state recovery,
      editor selection, and production application tests. The terminal does not
      provide a complete proposal-review or iterative file-selection UX, so
      `--architect`, `/architect`, and `/context` remain absent rather than
      advertising callback-only behavior through an installed CLI. Reopen only as
      a coherent terminal project with interactive approvals and packed-bin tests.
- [x] **P2 -- Summarize history on incompatible model switches.** **Status:**
      implemented. Before installing a profile with a different edit format, the
      concrete application forces bounded compaction through the current weak model
      with main-model fallback and usage accounting. Summarization, provider
      construction, strategy, fence, and map preparation all complete before the
      switch mutates state; failure keeps the old profile and raw history active.
      Replacement capability filtering then removes unsupported media.
- [x] **N/A -- Keep exact prompt and automatic localization parity out of the
      current product contract.** **Status:** accepted intentional difference.
      Patch uses shorter English-only production templates in
      `src/resources/strategy-prompts.ts:65-442`; Aider has format-specific prompt
      classes under `aider/coders/*_prompts.py` plus `--chat-language` at
      `aider/args.py:747-757`. Existing format fixtures prove selected structures,
      chunk order, fence interpolation, and parser behavior, not byte-for-byte prose
      or multilingual replies. Localization can be reopened as a separate feature
      only after public modes and language/configuration precedence are specified;
      it is not an unresolved correctness defect.
- [x] **N/A -- Preserve ambiguity rejection, authorization, and bounded
      recovery when porting edit behavior.** **Status:** intentional difference.
      This is security hardening.
      Patch rejects non-unique SEARCH/REPLACE and unified-diff candidates and stages
      authorized transactions before writes. Do not weaken these guarantees merely
      to match Aider's first-match or broader fuzzy behavior.

#### Commands and executable workflows

- [x] **P2 -- Keep read-only inspection to the bounded Patch commands.**
      **Status:** accepted scope. `/settings`, selected-file `/diff`, `/tokens`, and
      `/map` are production-wired, provider-free, sanitized/bounded where content is
      rendered, and covered through the installed package. `/map-refresh` is not a
      separate command because `/map` and ordinary turns already refresh the
      tracked/non-ignored inventory through the production map path; explicit cache
      policy remains a configuration decision under the map-control item.
      `/copy-context` is a privacy non-goal: it would place raw prompt, history,
      selected/read-only file, repository-map, and media context into an ambient OS
      clipboard, bypassing the existing bounded inspection views.
- [x] **N/A -- Keep exact command names and explicit arguments.** **Status:**
      accepted current-release scope. Patch does not port aider's `!`, bare
      `/read-only`, `/reset`, `/ask`, `/code`, `/ok`, `/multiline-mode`, or `/quit`.
      `/run` remains visibly previewed and approval-gated; file conversion requires
      explicit paths; `/drop` plus `/clear`, `/chat-mode`, startup multiline
      configuration, and `/exit` already expose the underlying operations without
      aliases or compound transitions. This preserves parser/completion exactness.
- [x] **N/A -- Keep file/script command breadth closed.** **Status:** accepted
      current-release scope. `/git` is redundant with approval-gated, bounded
      `/run git ...`; `/load` and `/save` introduce command files whose compound
      effects obscure per-effect approval and partial-failure recovery; `/editor`
      and `/edit` duplicate the terminal's Ctrl-X Ctrl-E draft editor. Patch retains
      one contained, cancellable, serialized path for each operation rather than
      adding aliases or a second persistence format.
- [x] **N/A -- Keep offline edit application out of Patch and deduplicate
      diagnostic-mode decisions.** **Status:** accepted non-goal and consolidation.
      Aider exposes `--apply`, `--apply-clipboard-edits`, `--exit`,
      `--show-repo-map`, and `--show-prompts` at `aider/args.py:669-697`. Patch does
      not accept stored model output or clipboard contents as edits because that
      would bypass the composed turn's immutable snapshot, preview, explicit path
      and write approval, transactional application, Git, and partial-failure
      accounting. A startup-only `--exit` is redundant with existing one-shot
      modes. Read-only prompt/map diagnostics are settled under the inspection and
      map-control decisions.
- [x] **N/A -- Consolidate model-search, reasoning, and role-model commands with
      their owning model controls.** **Status:** complete. `/models` belongs to the
      custom catalog contract, reasoning/thinking commands to capability controls,
      and weak/editor commands to independent role selection. All are now
      production-wired under their owning contracts rather than a duplicate alias
      milestone.
- [x] **N/A -- Keep `/help`, `/settings`, and `/report` local and bounded.**
      **Status:** intentional difference. Patch's implementations avoid Aider's
      model-backed help, broad settings dump, browser launch, and automatic upload.
      The accepted rationale and evidence remain in `PORTING_PLAN.md:140-149` and
      the ancillary-command section below.

#### Configuration, history, terminal, and clipboard

- [x] **N/A -- Keep persistence to explicit terminal history files.**
      **Status:** accepted privacy boundary. Patch supports opt-in append-only input
      JSON Lines with bounded recall and corruption-tolerant line skipping, plus an
      opt-in rendered Markdown chat transcript. Files are created owner-private
      where POSIX modes apply, are not redacted or encrypted, and remain under user
      retention/deletion control. Model-history restoration and LLM-wire logging
      are non-goals because they persist provider payloads, tool data, secrets, and
      raw media; command-file load/save is excluded with the command-breadth decision
      because replay obscures per-effect approval and partial failure.
- [x] **N/A -- Keep executable line endings on preserve.** **Status:** accepted
      current-release scope. Existing files retain their first observed LF/CRLF
      style; new files and files with no newline use the platform default.
      `FileSystemAdapter` retains explicit LF/CRLF options for embedding callers,
      but CLI/YAML/environment controls are a non-goal: a session-wide conversion
      can rewrite unrelated selected files and inflate diffs without a visible
      per-file conversion operation. This intentionally differs from aider's global
      `--line-endings` option.
- [x] **N/A -- Keep text encoding to UTF-8, UTF-16LE, and Latin-1.**
      **Status:** accepted intentional difference. Patch validates exactly those
      encodings in `src/io/filesystem.ts:12-20`; Aider passes a configured Python
      codec name through `aider/args.py:777-781` and `aider/io.py:237-266`. Patch's
      three-codec contract has fatal malformed-Unicode decoding, representability
      checks, round-trip encoding, UTF BOM retention, and newline coverage.
      Arbitrary Python/ICU codec names are a non-goal because availability and
      semantics would vary across the portable Node/npm package.
- [x] **N/A -- Keep one streaming presentation contract.** **Status:** accepted
      current-release scope. Provider output streams through Patch's sanitizer and
      dependency-free Markdown renderer. Styling follows TTY and `NO_COLOR`, with
      `--no-color` as the only override. Non-streaming, pretty/raw, palette,
      completion-menu color, code-theme, and diff-display controls are non-goals:
      they multiply terminal states without improving the safe text contract and
      would imply Rich-level rendering Patch does not implement.
- [x] **N/A -- Keep the richer terminal replacement out of current scope.**
      **Status:** accepted current-release boundary. Computed edit hunks, Rich-style
      tables/lists/wrapping and unstable-tail rerendering, and true Vi modal input
      require replacing the renderer and line editor as one project. Patch retains
      full-content previews, dependency-free streaming Markdown, Ctrl-X Ctrl-E, and
      one stateful sanitizer across untrusted output. Individual compatibility
      toggles would create misleading partial support.
- [x] **N/A -- Keep clipboard access text-only.** **Status:** accepted privacy
      and containment difference. Patch's `/paste` submits bounded text only, while
      `/attach` handles explicitly named, approved, repository-contained media.
      Aider's `aider/commands.py:1278-1327` probes for an image first and writes it
      to an external temporary directory. Patch will not silently inspect the OS
      image clipboard or create out-of-root media context; users save an image and
      select it visibly with `/attach <path...>` instead.
- [x] **N/A -- Keep generated completion to Bash, Zsh, and Fish.**
      **Status:** accepted supported scope. Patch generates deterministic completion
      from the live parser inventory at `src/program.ts:260-284`, with maintained
      tests for exactly those three shells. Aider delegates a larger set to shtab at
      `aider/args.py:853-862`; untested shell breadth is not part of Patch's current
      portable terminal contract.
- [x] **N/A -- Keep shell suggestions strategy-owned and use one Node readline
      path.** **Status:** accepted supported scope. Aider exposes
      `--suggest-shell-commands` and `--fancy-input` at `aider/args.py:806-817`;
      Patch binds shell suggestion policy
      to the selected edit strategy in
      `src/resources/strategy-prompts.ts:27-32,289-337` and always uses its Node
      readline path for interactive input. A model-suggested command remains
      previewed and approval-gated regardless of strategy. Alternate input stacks
      and runtime toggles are non-goals for the current terminal contract.
- [x] **N/A -- Keep history writes opt-in.** **Status:** intentional difference.
      This is a privacy decision. Patch writes input/chat history only when paths are
      configured at `src/program.ts:176-180,349-356`; Aider assigns default history paths at
      `aider/args.py:270-288`. Do not create persistent transcripts by default.

#### Repository maps, Git, filesystem, and recovery

- [x] **N/A -- Keep the shipped eleven repository-map entries.** **Status:**
      accepted current-release scope. JavaScript, TypeScript, TSX, Python, Go, Rust,
      Bash, C/C++, C#, Java, and Ruby retain pinned/package extraction evidence.
      Unsupported languages still contribute bounded lexical references to rank
      known definitions. Broader query inventory is not selected speculatively;
      each future language needs a concrete product requirement plus attributed
      query/grammar, pinned tags, cache fingerprint coverage, focused extraction,
      and packed cross-platform evidence.
- [x] **N/A -- Keep repository-map tuning internal.** **Status:** accepted
      current-release scope. Base tokens remain model-derived and bounded, refresh
      follows the production inventory/cache policy, and the empty-chat multiplier
      remains fixed. `/map` is the only display control and uses the same sanitized,
      bounded path as production. `--map-tokens`, refresh/multiplier settings,
      `--show-repo-map`, and `/map-refresh` are non-goals because they expose
      implementation details, destabilize prompt budgets, and multiply cache/ranking
      states without demonstrated operational need.
- [x] **N/A -- Keep repository-map parity evidence-scoped rather than claiming
      arbitrary-program/every-language equivalence.** **Status:** accepted evidence
      boundary. Patch has exact evidence for shipped tag samples, representative
      renderer cases, and one asymmetric personalization case. Aider's graph and
      TreeContext path is in `aider/repomap.py:365-804`; Patch's implementation is
      under `src/context/repo-graph.ts:30-180`,
      `src/context/tree-context.ts:18-129`, and
      `src/context/repo-map-renderer.ts:29-121`. Universal equivalence is not a
      finite product contract. Each future language or map behavior remains
      responsible for independent fixtures, packaged evidence, strict token
      ceilings, and unreadable-file isolation under the P2 language/control tasks.
- [x] **N/A -- Keep the existing composed Git policy.** **Status:** accepted
      current-release scope. Patch retains ordinary Git ignores plus fixed-root
      `.aiderignore`, literal selected paths, mandatory Git-enabled checkpoints and
      auto-commits, configurable hook verification, explicit attribution, bounded
      generated subjects, selected `/commit`, and session-owned `/undo`. Custom
      ignore paths, subtree-only behavior, ignored-file bypass, independent
      auto/dirty commit toggles, custom commit prompts/languages, and repository
      sanity bypasses are non-goals because they fragment disclosure/ownership
      invariants or create unsafe combinations.
- [x] **N/A -- Keep recovery process-local and explicit.** **Status:** accepted
      current-release boundary. Patch records surviving paths, commit IDs, and
      command outcomes; reconciles history; leaves the queue reusable; and serializes
      sessions sharing a worktree inside one process. It does not claim a durable
      journal, cross-process lock, rollback of completed atomic writes, interruption
      inside Git, or reversal of arbitrary approved/configured command side effects.
      Those guarantees require a new transaction architecture spanning filesystem,
      Git, and child processes, not an incremental recovery toggle.
- [x] **N/A -- Retain Patch's stronger path, metadata, ignore, and undo
      boundaries.** **Status:** intentional difference. This is security hardening.
      Literal Git pathspecs,
      symlink containment, regular-file/single-link checks, ancestor identity,
      staged transaction validation, session-owned commit IDs, compare-and-swap
      HEAD, and fail-closed publication checks must not be relaxed for upstream
      behavioral similarity.
- [x] **N/A -- Accept documented non-portable metadata limits.**
      **Status:** intentional difference. This is a platform limit: Node cannot
      portably preserve ACLs, extended
      attributes, file flags, or alternate data streams during atomic replacement;
      `docs/filesystem-safety.md:73-107` documents that boundary.

#### Lint, tests, commands, and process execution

- [x] **N/A -- Keep checks explicitly configured.** **Status:** accepted
      current-release scope. Patch runs one bounded `lint-cmd` and one bounded
      `test-cmd` at the repository root, with automatic reflection after failed
      edits and explicit `/lint`/`/test` dispatch. It does not inspect manifests to
      guess package-manager commands, compile languages implicitly, or bundle
      language-specific linters. Repository scripts own project flags,
      dependencies, and environment; inference would create unapproved side effects
      and platform-dependent behavior.
- [x] **N/A -- Keep noninteractive workflows on the normal lifecycle.**
      **Status:** accepted current-release scope. `--message` and `--message-file`
      already run one complete turn and return process status through the installed
      executable. Global `--dry-run` is a non-goal because arbitrary approved hooks
      and child commands cannot honor a reliable no-write guarantee. One-shot
      commit/lint/test flags duplicate serialized `/commit`, `/lint`, and `/test`
      commands and would create a second exit/status contract without new behavior.
- [x] **N/A -- Keep model-suggested commands approval-gated and bounded.**
      **Status:** intentional difference. This is security hardening. Patch never
      auto-runs model output, limits output/time, and reserves PTY access for an explicitly typed interactive
      command. Aider's broader `/run` and `/git` behavior must not bypass this policy.

#### Optional interfaces, web content, and ancillary product families

- [x] **N/A -- Keep browser GUI work closed.** **Status:** accepted
      current-release non-goal. Patch's authenticated loopback HTTP/SSE server is an
      API for trusted local clients, with quotas, replay/backpressure, expiry, and
      in-process worktree serialization. It is not a GUI. A browser product would
      require a second complete approval UX, token/secret storage, reconnect/session
      lifecycle, browser security policy, and interaction tests. No concrete product
      requirement justifies that permanent surface for the terminal-first release.
- [x] **N/A -- Keep voice embedding-only.** **Status:** accepted current-release
      scope. `@pierrunoyt/patch/voice` retains bounded recording/transcription,
      cancellation, cleanup, late-result rejection, and explicit session submission
      without entering the default dependency graph. CLI microphone/device UX is a
      non-goal: it requires cross-platform device selection, optional ffmpeg
      packaging, transcription-provider disclosure, transcript review before
      submission, and real-device/network evidence. Hosts using the subpath own
      those product and privacy choices.
- [x] **N/A -- Keep browser-rendered `/web` and automatic URL detection out of
      production.** **Status:** intentional security/privacy non-goal. Patch fetches
      one user-typed URL through the DNS-pinned, bounded, no-subresource path in
      `src/interfaces/url-fetcher.ts:99-280`; its optional static-HTML browser helper
      remains embedding-only. Aider can detect URLs and use Playwright/Pandoc at
      `aider/args.py:723-728,842-847` and `aider/scrape.py:79-250`. Implicit fetching,
      browser navigation, and subresource loading would create network side effects
      that are not covered by the command's explicit intent or approval contract.
      Reopen them only with a separate threat model and visible approval boundary.
- [x] **N/A -- Keep analytics out of Patch.** **Status:** non-goal. Aider's
      analytics controls and implementation are at `aider/args.py:567-594` and
      `aider/analytics.py:60-304`; Patch intentionally performs only local token/cost
      accounting.
- [x] **N/A -- Keep automatic onboarding/OAuth out of Patch.**
      **Status:** non-goal. Aider's onboarding is in `aider/onboarding.py:18-326`; Patch requires
      explicit model and credential configuration to avoid implicit browser,
      account, and credential-persistence effects.
- [x] **N/A -- Keep built-in update checks, self-upgrade, and automatic release
      notes out of Patch.** **Status:** non-goal. Aider exposes these at
      `aider/args.py:597-634` and `aider/versioncheck.py:15-104`; Patch leaves updates
      to npm and release communication to `CHANGELOG.md`.
- [x] **N/A -- Keep Python runtime, Aider subprocess, and Docker parity out of
      the npm package.** **Status:** non-goal. Patch's product contract is one
      Node.js 22+ package and executable; Aider's Python and Docker distribution
      surfaces are reference behavior, not runtime dependencies to port.

#### Validation evidence and remaining evidence gaps

Validation executed from the clean pinned checkouts during the 2026-09-14 pass:

- Patch `npm ci`: passed with 153 packages and no reported vulnerabilities.
- Patch `npm run check`: formatting, ESLint, TypeScript, 63-direct-derivation
  provenance, 685 tests passed with eight gated/platform skips, clean build,
  packed install, lifecycle smoke, commit-policy smoke, and installed
  `patch --help` all passed. Vitest reported 79 passed and two skipped test
  files.
- Patch `npm install --no-save --no-package-lock node-pty@1.1.0` followed by
  `PATCH_TEST_PTY=1 npm test -- tests/pty.test.ts tests/pty-provisioned.test.ts`:
  both files and all seven tests passed on Linux.
- Aider dependencies were installed into `/tmp/opencode/aider-venv`. The first
  `python -m pytest` run produced five voice failures because the sandbox lacked
  the system PortAudio library. After installing `libportaudio2`, the same full
  command passed 492 tests with one Windows-only skip.
- Aider `python -m build`: source distribution and wheel built successfully.
- Aider's exact pinned
  `pre-commit run --show-diff-on-failure --color=never --all-files` passed
  isort, Black, flake8, and codespell in an isolated archive of the pinned
  checkout. A separate newer flake8 7.3 invocation reported F824 at
  `aider/onboarding.py:231`; the repository-pinned flake8 7.1 hook passed, so
  this is not a Patch parity blocker.
- Focused built-code probes reproduced all three substantive Patch defects and
  exercised the corresponding Aider parser/helper behavior. The Patch and Aider
  worktrees were clean at final verification.

Evidence still unavailable or deliberately excluded:

- [ ] **P2 -- Obtain successful credentialed live-provider evidence for the
      current implementation revision.** **Status:** external blocker. Anthropic's
      catalog/factory/application-session turn completed with positive usage.
      Repeated OpenAI attempts reached the same production route but the available
      account returned rate-limit errors; `DEEPSEEK_API_KEY` was absent. All three
      deterministic full-path gates are implemented. Successful OpenAI and DeepSeek
      runs remain required; never add credentials to the default suite or logs.
- [x] **P2 -- Obtain current-revision macOS and Windows package evidence.**
      **Status:** complete for implementation revision
      `44dbae712d96cf6abdf65055d3b83ecdb9ec55e0`. CI run
      [`34987388922`](https://github.com/PierrunoYT/patch/actions/runs/34987388922)
      passed the Node 22 suite; package/platform jobs on Linux, macOS, and Windows;
      packed executable extraction for all eleven shipped repository-map languages;
      and provisioned PTY jobs on supported Linux and Windows. This does not add
      macOS PTY support or provider/device evidence.
- [x] **N/A -- Require real-device evidence only for release-selected surfaces.**
      **Status:** accepted release boundary. Microphone/CLI voice and browser GUI
      are current-release non-goals. Browser-rendered `/web` and automatic URL
      detection are also security/privacy non-goals. Loopback HTTP/SSE and optional
      voice helper tests remain API/adapter evidence, not browser/device evidence.
- [x] **N/A -- Keep provenance evidence split by purpose rather than recursively
      hashing aider's Python graph.** **Status:** accepted evidence boundary.
      `scripts/check-provenance.mjs:26-168` and `docs/direct-derivations.json` verify
      Patch's direct attribution; the current `c9c59c6` Git-tree inventory classifies
      every pinned product module and runtime resource, and fixture
      regeneration pins the twelve modules its driver imports directly, while also
      requiring the exact commit and a clean checkout. Transitive imports are
      environment- and execution-path-dependent, and blanket hashes would neither
      prove semantic equivalence nor replace the inventory. Add a source to the
      fixture manifest when the driver imports it directly, and add a targeted
      resource hash if a future fixture driver reads that resource directly.
      Generated/vendor/build/cache files and non-product historical website
      metadata remain outside the source-parity enumeration.

### Dated audit follow-ups — 2026-09-12

The [deep audit](aider-deep-audit-2026-09-15-5eecc98.md) found supported-surface
defects beyond the earlier feature inventory; all are fixed in its accompanying
change. Historical fixes below retain their original evidence boundaries.

- [x] **Bound history-summary input.** Each request reserves 512 tokens from the
      summarizing model's input window, counts the complete labeled request, sends
      only whole messages that fit, and retains unsent head messages for recursive
      compaction. Models without a declared limit use aider's 4,096-token fallback.
      Evidence: `tests/chat-summary.test.ts` and production propagation in
      `ConcreteApplicationSession.#summarize`.
- [x] **Add summarizer model fallback.** The concrete application tries the weak
      model and then the main model, charges every attempted request, closes
      temporary providers per attempt, prevents fallback after cancellation, and
      leaves completed history unchanged when both fail. Evidence:
      `tests/application-prompt-context.test.ts`.
- [x] **Add production fallback map requests.** An empty selected-file map
      retries globally with the same filename/identifier hints, then globally
      without hints, stopping at the first result. Every request reuses the current
      filtered tracked inventory. Evidence: the concrete request-sequence cases in
      `tests/application-prompt-context.test.ts`.
- [x] **Complete scoped TreeContext rendering and model-aware fitting.** Shipped
      grammars use the pinned map configuration's generic parent scopes, shortest
      capped headers, top-scope omission, and deterministic elisions. Production
      fitting uses `tiktoken` for recognized OpenAI models and a documented
      conservative estimate elsewhere. Exact Python/TypeScript cases supplement the
      normalized upstream map. Evidence: `tests/repo-map-renderer.test.ts`,
      `tests/repo-map-compatibility.test.ts`, and `tests/token-count.test.ts`.
- [x] **Complete scoped repository-map evidence.** The generated pinned fixture
      records a complete asymmetric tag multiset and upstream numeric personalized
      definition ranks; exact Python/TypeScript rendering and a Patch-specific
      lexical-reference case cover rendering; package smoke drives filtered ranked
      map content through the actual installed bin and deterministic provider while
      excluding an ignored tracked path. Evidence: `tests/upstream-fixtures.test.ts`,
      `tests/repo-map-compatibility.test.ts`, and `scripts/package-smoke.mjs`.
- [x] **Normalize and deduplicate unified-diff hunks.** Whitespace-only
      old/new/context lines become blank lines, no-op normalized hunks are dropped,
      and identical normalized path/search/replacement hunks resolve once. Evidence:
      `tests/unified-diff.test.ts`.
- [x] **Add indentation and omitted-line unified-diff recovery.** Recovery
      requires one unique indentation-normalized window or one unique bounded
      ordered subsequence. Omitted-line search caps hunks at 100 lines, permits at
      most 20 omitted lines, and stops after 10,000 comparisons. Evidence:
      `tests/unified-diff.test.ts`.
- [x] **Complete partial-context unified-diff recovery.** Outer unchanged
      context is reduced over at most 256 exact/indentation candidates; no-final-
      newline assertions cannot be discarded, and ambiguity always fails closed.
      Generated pinned fixtures cover indentation, omitted lines, and partial
      context; package smoke drives partial recovery through the actual installed
      bin. Evidence: `tests/unified-diff.test.ts`,
      `tests/upstream-fixtures.test.ts`, and `scripts/package-smoke.mjs`.
- [x] **Route the DeepSeek live contract through production boundaries.** The
      gated test resolves the advertised bundled model, overlays only a 16-token
      output cap, constructs the real factory through `ConcreteApplicationService`,
      and submits a real session turn. Deterministic full-path coverage runs without
      credentials in `tests/deepseek-provider.test.ts`.
- [x] **Route OpenAI and Anthropic live contracts through production
      boundaries.** Their gated turns now use the same bounded catalog, factory, and
      `ConcreteApplicationService` helper as DeepSeek while preserving their direct
      image/cache-control, timeout, cancellation, usage, and stop-state contracts.
- [ ] **P2 — Close current-revision live-provider evidence.** This is the same
      external blocker recorded in the live evidence section above. All three gates
      are implemented; Anthropic passed, OpenAI was rate-limited, and DeepSeek had
      no credential. Do not count this historical follow-up as a second task.
- [x] **N/A — Keep richer terminal replacement out of current scope.** Computed
      edit hunks, Rich-style rendering, and true Vi input require one coherent
      renderer/line-editor replacement; full previews, streaming Markdown,
      Ctrl-X Ctrl-E, and sanitization remain the supported contract.

### Historical audit follow-ups — 2026-09-11

The items below are completed fixes to findings in the
[2026-09-11 dated audit](aider-parity-audit-2026-09-11.md). They remain here to
preserve revision-specific source references and evidence boundaries.

- [x] Compose `.aiderignore` with ordinary global Git exclusions; test both
      policies before selection and provider-context construction. `filterIgnored`
      runs `check-ignore` once under the repository's ordinary rules and, when
      `.aiderignore` exists, once more with that file as `core.excludesFile`, then
      unions the results, so a path excluded only by a global ignore file is no
      longer eligible. This matches upstream, which keeps `ignored_file` and
      `git_ignored_file` separate. Every consumer — selection, mention matching,
      repository maps, and provider messages — goes through that one method.
      Evidence: the composition cases in `tests/git-repository.test.ts` and the
      selection and provider-context case in `tests/interface-startup.test.ts`;
      both fail against the previous override.
- [x] Supply input limits and catalog prices for advertised bundled models,
      model cache-hit/write pricing, and test executable budgeting/accounting. All
      six advertised models carry `maxInputTokens`, `maxOutputTokens`, and input,
      output, cache-read and cache-write prices taken from the LiteLLM table the
      pinned aider revision resolves them from; an entry added without limits or
      prices fails `tests/model-metadata-merge.test.ts`. The limit refuses an
      oversized prompt before the provider call, proved through the application in
      `tests/interface-startup.test.ts`. Cost prices the cached and written subsets
      of the input count separately, and each adapter normalizes to one contract —
      `inputTokens` is every billed input token — because OpenAI includes cached
      tokens in its prompt count and Anthropic does not. Evidence:
      `tests/usage.test.ts`, the usage case in `tests/anthropic-provider.test.ts`,
      and the accounting line in `tests/render.test.ts`.
- [x] Complete the fixture-source hash manifest and add coverage that detects
      newly imported but unlisted sources. All twelve direct imports are pinned;
      `tests/upstream-fixtures.test.ts` derives coverage from the driver and tests
      unlisted imports, removed entries, and real exporter rejection of changes
      hidden by `assume-unchanged` or `skip-worktree`. Hashes match the pinned
      checkout. Transitive imports and resource hashes are outside this guarantee.
- [x] Expose and verify production commit policy rather than forcing fixed
      messages, disabled hooks, and no attribution. CLI/YAML/environment controls
      reach checkpoints, model-edit commits, configured checks, and `/commit`.
      Message generation and explicit identity changes remain opt-in; explicit
      manual messages bypass the provider. `tests/application-lifecycle.test.ts`
      verifies real hooks, attribution scope, diff-only privacy, accounting, bounds,
      cancellation, and pre-/post-write recovery. `scripts/lifecycle-smoke.mjs`
      exercises generation, hooks, and committer identity in the installed package.
      Compared with pinned `aider/repo.py`, `aider/args.py`, and `aider/prompts.py`;
      defaults, automatic name suffixes, model fallback/retry, prompt/language
      controls, and independent auto/dirty-commit switches remain intentional
      differences or unsupported controls in [Git policy](git-repository.md).
- [x] Wire the distinct fenced-diff prompt and test the actual provider request.
      `diff-fenced` now puts the filename immediately after the opening fence and
      language in its system instruction, example, and reminder, while ordinary
      `diff` keeps the filename before the fence. Both examples use the fence
      selected from current file content. `tests/application-prompt-context.test.ts`
      compares both concrete application requests and forces quadruple backticks,
      proving that the provider receives the selected markers. The parser and shell
      policy remain shared as at pinned `aider/coders/editblock_fenced_coder.py`;
      full canonical format-specific prompt text and per-attempt fence reselection
      remain open under R1.
- [x] Pin and handle unified-diff no-newline behavior, then broaden recovery
      fixtures without weakening ambiguity rejection. Standard markers now remove
      the synthetic trailing newline from the immediately preceding old, new, or
      context line as appropriate; detached markers are rejected. Local fixtures
      cover preserving, adding, and removing a final newline through parse,
      resolution, and application, plus malformed placement and repeated no-newline
      context. Pinned aider ignores marker semantics and always adds a newline, so
      Patch intentionally implements the standard Git meaning while retaining its
      stricter all-length unique-match requirement. Normalization, duplicate
      suppression, and bounded ambiguity-rejecting indentation, omitted-line, and
      partial-context recovery are now complete under Phase 7.
- [x] Preserve exact existing filenames containing glob metacharacters through
      selection; test beside files that would match the same pattern. Selection now
      resolves and stats the exact contained path before deciding whether its text
      is a glob. Existing files are selected literally, existing directories are
      walked literally, and only a missing exact path reaches pattern expansion.
      `tests/selection.test.ts` proves `[ab].txt` wins beside `a.txt`/`b.txt` while a
      missing `[ab].md` still expands; `tests/interface-startup.test.ts` proves the
      literal path through executable `/add`. Containment, ignore filtering, walk
      and result bounds, and later Git literal-pathspec handling are unchanged.
- [x] Expose safe structured partial-turn errors to authenticated HTTP clients
      without leaking raw internal errors, and test post-write failure recovery.
      Authenticated message requests now retain HTTP 500 but return stable code
      `turn_partially_applied` plus an allowlisted `partial` object: bounded safe
      repository-relative paths, a validated Git object ID or `null`, and command
      status/exit/truncation only. Causes, messages, command text, stdout, and stderr
      remain private; malformed absolute/control paths and invalid commit IDs are
      omitted. `tests/web-server.test.ts` injects secrets into every excluded field,
      and `tests/interface-startup.test.ts` drives a concrete four-attempt turn whose
      edits survive a failing configured check and verifies both the response and
      final file. Unexpected failures remain generic.
- [x] Establish passing `platform` job evidence on macOS and Windows. Run
      [`34618401395`](https://github.com/PierrunoYT/patch/actions/runs/34618401395)
      on `baebd0e83a1f317b0aba48da174feae04a7b7e61` is green on all six jobs, and
      the macOS and Windows `platform` jobs completed `Run platform-sensitive
contracts`, `Build package`, and `Test packed bin and repository-map
languages`. That is the first packed-install and eleven-language extraction
      evidence on those platforms; every run from 2026-09-10 20:18 onward had failed
      the contracts step before `Build package`. The three test defects behind it
      were corrected without weakening production containment: the permission
      assertion now checks retention rather than a POSIX mode Windows never records,
      the ancestor-swap injection swaps the directory after the temporary file is
      closed rather than while Windows holds its handle, and path-resolution
      fixtures are canonicalized the way `SafePathResolver` canonicalizes its root.
      This establishes the jobs for that revision only; a later claim needs its own
      run id.

### Review follow-ups — 2026-09-12

- [x] Require the session-owned commit ID in `undoLastPatchCommit`, including
      runtime refusal for untyped callers that omit it. Real-Git regression tests
      cover missing/invalid ownership and a different marker-bearing HEAD. The
      executable already supplied its owned ID; this closes an adapter API bypass,
      not a demonstrated executable bypass. Rechecked pinned `aider/commands.py:560–644`.
- [x] Fail closed on publication-check errors during undo. Missing configured
      refs and unexpected ancestry errors refuse mutation; only exit 1 means
      non-ancestry. Real-Git tests also retain detached/no-upstream and unpublished
      undo. Rechecked pinned `aider/commands.py:607–621`; Patch intentionally uses
      configured-upstream ancestry, not origin/HEAD equality or fail-open errors.
- [x] Handle filenames beginning with Git pathspec magic in ignore checks by
      prefixing NUL-delimited inputs with `./` and normalizing returned names.
      Real-Git adapter tests cover both ignore policies on Windows as well; actual
      colon-named selection/context coverage is POSIX-only. Rechecked pinned
      `aider/repo.py:523–565`; unexpected Git failures still abort selection.
- [x] Make unused process-wide worktree locks reclaimable through weak references
      and finalizer cleanup that cannot delete a newer same-root entry. Live sessions
      retain a shared lock even while idle; cleanup is GC-dependent, not immediate.
      Deterministic finalizer-order tests and live serialization tests cover this
      Patch-specific policy, compared with pinned `aider/gui.py:70–89` and
      `aider/commands.py:560–644` rather than claiming an upstream lock equivalent.
- [x] Cover `captureAndSubmit` cancellation and abort-listener cleanup. Fake
      adapter/session tests establish forwarding during all three stages and cleanup
      on success/failure/cancellation. Regressions exposed pre-aborted recording and
      late-transcript submission; boundary checks now refuse both. This remains
      library-only evidence, compared with pinned `aider/voice.py:106–180`; real
      devices, ffmpeg cancellation, live transcription, and CLI UX are not covered.
- [x] Describe full-content edit previews accurately. Documentation and renderer
      tests explicitly show unchanged lines on both sides; no runtime diff algorithm
      was added. Compared with pinned `aider/diffs.py:43–96` and
      `aider/coders/wholefile_coder.py:136–140`.
- [x] Keep computed edit-preview hunks and unchanged-context elision out of the
      current release; full-content previews remain the documented contract.

Validation for these review follow-ups: on Windows, Patch `edb2cd1c3` passed
`npm run check` (659 tests passed, nine skipped; format, lint, typecheck,
63-derivation provenance check, build, and packed-install smoke passed) and
`npm start -- --help`. The new colon-filename application test is skipped on
Windows; the leading-magic ignore adapter regression ran and passed. Upstream
comparison used the clean external checkout at
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`. This is local Windows evidence,
not a new cross-platform CI or live-provider/device result.

### Historical immediate P0 checklist

The original immediate P0 and P1 lists below record completed milestones, not
current release blockers. P2 ancillary commands are implemented and verified,
the fixture-import gap is closed, and current product differences have explicit
dispositions. The live task register controls release readiness.

- [x] Make every Git path argument literal so pathspec magic cannot stage,
      commit, diff, or undo unrelated files.
- [x] Filter tracked `.aiderignore` paths before snapshots, mention matching,
      repository maps, or provider requests.
- [x] Preserve move sources until destinations are durably created. `commit`
      writes and syncs every creation/update before any deletion and rechecks each
      deletion's resolved content immediately before the unlink, so an interrupted
      move or a case-only rename cannot leave the content deleted.
- [x] Reject or correctly implement named Patch `@@` scopes, repeated actions,
      and conflicting actions for one path. Scopes advance the search cursor or are
      rejected, repeated update blocks merge with an overlap check, and duplicate or
      conflicting add/delete/move actions are rejected as upstream does.
- [x] Parse every unified-diff file-header transition. A `--- `/`+++ ` pair
      inside a fence closes the pending hunk and retargets the following hunks, and
      git prefixes are stripped only when both headers carry them.
- [x] Bind undo to a commit owned by the current session and recheck HEAD
      atomically before reset. `/undo` reverts only the commit this session
      recorded, and `update-ref` performs a compare-and-swap on HEAD. Root, merge,
      and already-pushed commits are refused.
- [x] Serialize repository mutations across application sessions, especially
      local HTTP/SSE sessions sharing one worktree. A re-entrant
      `WorktreeMutationLock`, held process-wide per resolved root, wraps every
      region that observes or changes the worktree: the checkpoint/apply/commit/
      lint/command/test phase of a turn, each Git commit, each configured check,
      an approved `/run`, and the check-and-reset pair behind `/undo`. Streaming
      stays outside the lock, and so does the approval prompt for `/run`, captured
      or interactive: a prompt waits on a person, and blocking every other session
      until someone answers is worse than the race it would prevent. Two things do
      hold the lock and are meant to — the apply transaction, whose model-suggested
      commands are approved inside it because the transaction is atomic, and
      generated commit messages, whose provider call sits between staging the diff
      and committing it. Separate processes on one worktree remain ordered only by
      Git's own index lock, which is documented as a limit rather than a guarantee.
- [x] Apply one stateful sanitizer to all untrusted terminal output, not only
      PTY child output. `ControlSequenceSanitizer` now lives in `src/io/sanitize.ts`
      and is used by PTY output, `MarkdownStream` (one instance per stream, so a
      sequence split across provider deltas cannot rejoin), every one-shot render
      path through `stripAnsi`, both Commander output streams, and the executable's
      failure messages. It removes C0 controls other than tab/newline/carriage
      return, DEL, the C1 range, 7-bit and 8-bit CSI, OSC/DCS/SOS/PM/APC strings
      with either terminator, single shifts, and escapes carrying intermediates.
- [x] Complete the metadata and ancestor check-to-use policy for replacement and
      deletion. Replacement now carries mode bits and, where the process is
      permitted, owner and group; identity comparison includes ownership. The
      containing directory's device and inode are captured when a mutation is
      prepared and rechecked immediately before the rename or unlink, so a
      directory swapped for a different one at the same path is refused with
      `AncestorChangedDuringWriteError`. ACLs, extended attributes, file flags, and
      alternate data streams are documented as not preserved — Node exposes no
      portable API for them, and preserving them would mean in-place writes and
      partial content — and the residual check-to-use window is documented as
      detection rather than prevention. Evidence: `tests/filesystem-ancestor.test.ts`
      and the ownership case in `tests/filesystem.test.ts`; policy in
      `docs/filesystem-safety.md`.

### Next P1 correctness work

- [x] Atomically switch the active model and complete strategy definition;
      rebuild prompts, shell policy, fence, map policy, and compatible history.
      `/model` and `/chat-mode` build a whole `SessionProfile` — main model, the
      format `/chat-mode code` returns to, strategy definition, reselected fence,
      and the repository map the new model's `useRepoMap` requires — and install it
      only after `CoderSession.switch` accepts the change, so a failed provider or a
      rejected switch leaves the previous model active. The selected fence now wraps
      file messages, and history drops media the replacement model cannot accept.
      Automatic history summarization stays P2. Evidence:
      `tests/application-prompt-context.test.ts` and the switch cases in
      `tests/coder-session.test.ts`.
- [x] Submit text returned by `/paste` as a user turn instead of displaying and
      recording it as assistant output. The clipboard text becomes the turn message
      verbatim and is never reparsed as a command, so clipboard content the user did
      not write cannot dispatch an effect; an empty clipboard is rejected. Clipboard
      images remain unread. Evidence: the paste cases in
      `tests/application-commands.test.ts`.
- [x] Normalize DeepSeek endpoint model/output parameters and prefill requests;
      retain final usage events through `CoderSession`. `OpenAIProvider` takes a
      `deepseek` dialect that strips the `deepseek/` routing prefix, sends
      `max_tokens` instead of `max_completion_tokens`, and marks a trailing
      assistant message `prefix: true` on the endpoint's `/beta` path;
      `createProvider` selects it from the model's provider. `CoderSession` drains
      the provider stream past the finish event, so the usage chunk OpenAI-compatible
      endpoints send after it is accounted instead of dropped. Metadata merging and
      temperature policy stay P2. Evidence: `tests/deepseek-provider.test.ts` and the
      post-finish usage case in `tests/coder-session.test.ts`.
- [x] Make default non-repository startup and a sole directory target explicit
      supported or clearly rejected workflows. Both are rejected, by name and with
      the alternative: startup outside a worktree reports that Git integration is on
      and names `--no-git`, rather than surfacing a bare `git rev-parse` failure, and
      a directory passed to `--file`, `--read-only`, `/add`, or `/read-only` no
      longer fails later as `EISDIR`. A path that does not exist yet stays
      selectable. Directory and glob expansion landed with the P2 selection item
      below, which replaced the interim rejection. Evidence: the startup rejection
      cases in `tests/interface-startup.test.ts`.
- [x] Add a clean `prepack` build/resource step before any publication claim.
      `prepack` runs `npm run build`, which cleans `dist/`, recompiles, and recopies
      the runtime resources, so `npm pack`, `npm publish`, and a Git-URL install all
      package a current build rather than whatever happened to be on disk.
      `scripts/package-smoke.mjs` asserts the tarball carries `dist/cli.js`,
      `dist/index.js`, the three model resource files, and the repository-map
      resources.
- [x] Reconcile history and structured partial results whenever files or commits
      survive a later failure or cancellation. The application reports each write and
      each checkpoint/apply commit through `CoderSession.recordTurnMutation()`, so an
      interrupted turn whose work survives appends its user message, reflection
      exchanges, and model response to history instead of being discarded, while a
      turn that changed nothing still leaves none. `submit()` wraps such a failure in
      `TurnPartiallyAppliedError`, which carries `changedPaths`, `commit`, and
      `commands` and names them in the message the terminal and HTTP interface
      print. A durable recovery journal and per-file partial-write results remain out
      of scope. Evidence: the reflection-limit case in
      `tests/application-lifecycle.test.ts` and the reconciliation case in
      `tests/coder-session.test.ts`.
- [x] Isolate missing/unreadable tracked files during map construction and emit
      the canonical no-editable-files prompt pair. `RepositoryMap.getMap` now catches
      per path: a tracked path that is gone, unreadable, or unparseable is dropped
      from the map and listed in `skippedPaths` instead of failing the turn that
      asked for the map. The editable-files chunk is a user/assistant pair in all
      three upstream shapes — file contents with the assistant's acknowledgement,
      `filesNoFullFilesWithRepoMap` with its reply when a map is present, and
      `filesNoFullFiles` with `Ok.` otherwise. Surfacing skipped paths to the user
      stays P2. Evidence: the isolation case in `tests/repository-map-cache.test.ts`
      and the prompt-pair cases in `tests/application-prompt-context.test.ts`.
- [x] Surface watch submission/native watcher failures and refresh all selected
      AI comments for a triggered turn. `WatchModeOptions.onError` receives both
      submission failures and native watcher errors, and the terminal prints
      `Watched turn failed` or `Watch mode stopped` with the reason instead of
      discarding it. Once a changed file triggers, `WatchModeOptions.selectedPaths`
      supplies the chat's files and their AI comments join the prompt, so a comment
      written earlier in another selected file is not dropped. Adding a changed file
      to the chat, as Aider does, stays out of scope because it would bypass path
      approval. Evidence: the refresh and failure-reporting cases in
      `tests/watch-mode.test.ts`.

### P2 parity and evidence work

- [x] Add automatic long-history summarization and model-configured reasoning-tag
      normalization before display, history, or edit parsing. `ChatSummary` ports
      aider's split-and-recurse algorithm and runs before every turn whose completed
      history exceeds the model's `maxChatHistoryTokens`, summarizing with the active
      model's weak model; a summarizer that fails leaves history untouched rather
      than failing the turn. `ReasoningTagSplitter` divides a complete
      `reasoningTag` span as it arrives, so that span reaches neither answer display,
      history, nor the edit parser. A response whose closing tag has no opening tag
      is reclassified while the accepted attempt remains observer-buffered, so the
      prefix becomes reasoning and only the answer reaches display, continued
      output, history, and parsing. Evidence: `tests/chat-summary.test.ts`,
      `tests/reasoning-tags.test.ts`, and the summarization case in
      `tests/application-prompt-context.test.ts`.
- [x] Merge executable metadata limits/prices/capabilities, add temperature
      policy, broaden transient error classification, and render usage/cost.
      `ModelCatalog.resolve` folds metadata into the settings a session uses;
      `useTemperature` decides whether a request carries no temperature, a
      deterministic `0`, or an explicit value; `transientByStatus` retries 408, 429,
      409 and any 5xx in both adapters and treats an unreadable chunk as retryable;
      and `ApplicationTurnResult` carries the usage report and running session cost
      so the terminal prints one accounting line per turn. Evidence:
      `tests/model-metadata-merge.test.ts`, the classification case in
      `tests/openai-provider.test.ts`, the rendering case in `tests/render.test.ts`,
      and the accounting case in `tests/interface-startup.test.ts`.
- [x] Add important-root-file priority, per-file lexical reference fallback,
      model-aware map sizing, live inventory refresh, extractor-versioned caches,
      and broader language/query fixtures. `filterImportantFiles` ports aider's
      root-file list and those files are listed before ranked symbols;
      `lexicalReferences` gives files no grammar covers a place in the ranking graph;
      `repoMapTokens` sizes the budget from the model's input limit and widens it
      when nothing is in the chat; the tracked inventory is re-read per turn; the tag
      cache carries an extractor/query/grammar fingerprint; and Bash, C/C++, C#,
      Java, and Ruby were added with their upstream queries, bringing the production
      map to eleven languages. Context mode is implemented under R6, and ordinary
      turns now retry empty maps globally with and then without hints. Evidence:
      `tests/repo-map-renderer.test.ts`, `tests/tag-extractor.test.ts`,
      `tests/repository-map-cache.test.ts`, and the inventory/fallback cases in
      `tests/application-prompt-context.test.ts`.
- [x] Connect completion, opted-in history navigation, Emacs/Vi bindings,
      external editor, true multi-turn multiline input, and explicit PTY dispatch.
      Tab completes commands and the files selected at that keystroke;
      `--input-history-file` also seeds recall; Alt-Enter holds a line so a message
      spans lines with a bare Enter still submitting; Ctrl-X Ctrl-E edits the whole
      draft in `--editor`/`VISUAL`/`EDITOR` and returns the result to the prompt;
      and `/run --interactive` dispatches one user-typed, approved command through
      `runPtyCommand`, releasing and restoring the line reader around it. Vi modal
      editing is not implemented, so `--vim` is refused by name rather than ignored.
      Child output stays sanitized, so full-screen programs are out of scope.
      Evidence: `tests/input-editing.test.ts`, `tests/interactive-command.test.ts`,
      and the `--vim` case in `tests/cli.test.ts`.
- [x] Add contained path/directory/glob selection semantics and complete visible
      subprocess output/status without weakening Patch's authorization bounds.
      `expandSelection` resolves a directory or a `*`/`**`/`?`/`[...]` pattern to the
      files it covers: the walk starts at the pattern's fixed prefix inside the
      resolved root, skips symbolic links and `.git`, drops ignored matches, refuses
      an absolute glob, and is bounded by a file limit and a directory-entry limit,
      so widening a selection cannot reach outside the worktree, follow a link out of
      it, or pull ignored content into context. Existing literal paths are checked
      before glob interpretation, including names such as `[ab].txt`. Every
      authorization step is unchanged: each expanded path still goes through
      `approvePath`, and a named path keeps its own diagnostics. `/run` now reports
      the command, both streams, the exit status, and truncation; a model-suggested
      command reports through `command-complete` as it finishes and configured
      checks through `lint-complete`/`test-complete`, all rendered by the terminal. Evidence:
      `tests/selection.test.ts`, the expansion case in
      `tests/interface-startup.test.ts`, the output cases in
      `tests/application-commands.test.ts` and `tests/render.test.ts`, and the event
      ordering case in `tests/application-lifecycle.test.ts`.
- [x] Define URL ingestion and HTML-to-readable-text behavior; keep the strict
      SSRF/no-subresource policy as an intentional security difference. `/web <url>`
      fetches exactly one user-typed URL — a URL a model or a fetched page mentions
      is never followed, and Patch does not detect URLs in prose as Aider does — and
      adds its readable text to history as a user message labeled with the URL
      redirects ended at, truncated to a quarter of the model's input window.
      `htmlToReadableText` replaces upstream's BeautifulSoup/pandoc pair with a
      dependency-free converter that keeps headings, lists, and absolute `http(s)`
      links and drops scripts, styles, media, and every other attribute, so no
      inline payload reaches the model. The fetcher is constructed on first use, and
      its SSRF, redirect, size, TLS, and no-subresource policy is unchanged and
      documented as an intentional difference. Playwright rendering stays a library
      helper that `/web` never uses. Evidence: `tests/url-ingestion.test.ts` and
      `tests/url-fetcher.test.ts`.
- [x] Decide explicit dispositions for Aider help, report, settings, browser GUI,
      voice UX, analytics, onboarding/OAuth, and update/release-note families.
      Recorded 2026-09-11 in
      [`PORTING_PLAN.md`](../PORTING_PLAN.md#ancillary-feature-dispositions--p2-item-7):
      implement local `/help`, allowlisted `/settings`, and a local reviewable
      `/report` draft; defer browser GUI and voice UX; make analytics, automatic
      onboarding/OAuth, and built-in update/release-note flows non-goals.
      The product decision and the executable `/help`, `/settings`, and `/report`
      acceptance tasks below are complete. Cost/privacy rationale and pinned source
      references are retained in the plan. Source review also corrects the earlier
      table: settings uses
      `aider/format_settings.py`, and upstream ordinary version probes are throttled
      for 24 hours, not sent on every startup.
- [x] Complete fixture-source hash coverage while retaining the implemented
      clean-tree checks, broader goldens, packed extraction, and documentation tests.
      The 2026-09-11 audit found direct imports of
      `aider/coders/__init__.py`, `aider/coders/udiff_coder.py`, and `aider/special.py`
      missing from `fixtureSources`; all three now carry their pinned blob hashes.
  - Dirty-upstream and listed-source blob checks are implemented:
    `npm run fixtures:upstream` refuses a dirty checkout and checks committed
    and on-disk hashes for each manifest entry. `tests/upstream-fixtures.test.ts`
    now checks the driver's explicit direct imports instead of a fixed list and
    proves hidden-change rejection using the real exporter and temporary Git
    repositories. This does not cover transitive imports or resource hashes.
  - Packed extraction: `scripts/package-smoke.mjs` extracts a real sample for
    each of the eleven shipped languages, TSX included, from the installed
    tarball.
  - Installed documentation: the package ships `docs/`, and package smoke
    asserts the documents the README and help point at are both in the tarball
    and present after install.
  - Exact CI evidence: the jobs a claim may cite are tabulated under
    [Continuous integration jobs](#continuous-integration-jobs).
  - Broader production goldens: the fixture set grew from one two-file Python
    repository map to one tagged sample per shipped language — all eleven —
    plus the important-root-file selection and unified-diff parsing for a
    two-file response. Patch reproduces upstream's tags exactly for each
    committed language sample; the unified-diff golden records one deliberate
    divergence, where upstream keeps a `b/` prefix on a mid-block file transition
    and Patch strips it. Golden coverage for each remaining advertised edit format is tracked
    with R6's fixture item. Evidence: `tests/upstream-fixtures.test.ts`.

### Ancillary-command implementation follow-ups

These are implementation tasks created by the P2 item 7 decision. They must all
be resolved before claiming the selected command scope complete; checking the
decision or one command does not establish release readiness.

- [x] Implement `/help` command listing and bounded local search over installed
      Patch docs. Test no-query, matching, no-match, malformed/oversized input, and
      missing-doc behavior; verify from an installed tarball outside the checkout
      with no provider calls, downloads, or network access.
      `src/commands/help.ts` searches six allowlisted Markdown documents, returns at
      most eight 240-character line excerpts with source locations, and degrades to
      a safe message when no bundled document can be read. Parser, application, and
      package-smoke tests cover the stated cases and prove command dispatch does not
      call the provider or change chat history. This is intentionally local and
      deterministic rather than pinned aider's model-backed help coder.
- [x] Implement read-only `/settings` from an explicit safe-field allowlist,
      reflecting both resolved bootstrap and current model/mode. Test post-switch
      output and credential-bearing environment, headers, endpoint URLs, and custom
      model configuration; no secret values or suffixes may appear in terminal
      output, history, or provider requests.
      `src/commands/settings.ts` accepts only nine declared safe values: bounded
      current model/mode labels, encoding, five booleans/configured states, and the
      root-correction flag. It cannot receive raw argv, paths, commands, identities,
      environment, provider objects, headers, endpoints, or model extras. An
      executable-interface test covers a secret-bearing environment and custom model
      plus post-startup model/mode switches, asserting full secrets and suffixes are
      absent from terminal output, both histories, and provider requests. Package
      smoke also dispatches `/settings` from the installed executable.
- [x] Implement `/report` as a bounded local, reviewable draft with allowlisted
      version metadata and a user-supplied title. Test unavailable Git metadata,
      oversized/control-character input, and exclusion of credentials, paths, chat,
      source, environment, and raw diagnostics. No browser, upload, or automatic
      provider turn; user-supplied text must be visibly identified for review.
      `/report [title]` now renders only validated Patch, Node.js, OS, architecture,
      and Git versions; unavailable or malformed metadata becomes `unavailable`.
      Titles are limited to 160 control-free characters and visibly JSON-quoted as
      user input. Parser, renderer, and application tests cover malformed metadata,
      unavailable Git, cancellation, secret/path exclusion, no provider use, and
      unchanged chat history. Unlike pinned `aider/report.py`, no browser, issue URL,
      upload, provider, or network path exists. Combined packed execution remains
      the next unchecked item.
- [x] Verify all three through executable dispatch and packed installation,
      including queued commands, cancellation, and terminal sanitization, without
      weakening write/process approval. Update command completion, README, parity
      evidence, and help together; until then none is advertised as available.
      `tests/application-commands.test.ts` submits all three behind an active
      provider turn, cancels an additional queued report before metadata collection,
      checks active report cancellation, replaces hostile metadata with
      `unavailable` before terminal output, and proves none invokes path, write, or
      process approval hooks. `scripts/package-smoke.mjs` dispatches `/help`,
      `/settings`, `/report`, and `/exit` through the actual installed bin. The
      parser-owned command inventory supplies completion, so `/report` is included
      without a parallel advertising list. No provider credentials or network are
      used.

The R0–R9 sections below retain dependency context. Where a checked component
conflicts with this re-audit, the unchecked blocker above controls release
status.

## R0 — Restore a portable default installation

**Status:** Complete. `node-pty` is absent from the default dependency graph and
is loaded only when explicitly provisioned for PTY execution. Package smoke
coverage verifies that normal installs do not include optional native, browser,
or audio dependencies.

- [x] Remove `node-pty` from the package's default dependency graph and update
      `package-lock.json`.
- [x] Keep `runPtyCommand` behind dynamic loading with a focused unavailable
      error. If discoverability requires metadata, use an optional peer dependency
      only after a clean-install test proves npm does not fetch or build it;
      otherwise document a separately installed external package.
- [x] Ensure importing the package root, invoking `patch --help`, and using
      non-PTY commands never resolve or probe `node-pty`.
- [x] Add package-smoke assertions that a plain clean install contains no
      `node-pty`, Playwright, bundled browser, ffmpeg, or native audio package.
- [x] Add a separately gated PTY job that explicitly installs `node-pty` and
      runs PTY contract tests on supported platforms.
- [x] Enforce LF line endings at checkout so the formatting gate remains
      deterministic on Windows hosts configured with `core.autocrlf=true`.
- [x] Restrict test discovery to `tests/**/*.test.ts`, clean `dist/` before each
      build, and reject packed tarballs containing compiled tests.
- [x] Keep cross-platform assertions aligned with the pinned Aider relative-path
      behavior and Patch's platform-default newline policy for new files.
- [x] Use an explicit cross-platform timeout for the real-Git reflection-limit
      test while retaining the production reflection and subprocess limits.

**Acceptance:** a plain `npm install` of the packed tarball performs no native
build and contains none of the optional native/browser dependencies, while an
explicitly provisioned PTY test still passes. The Phase 0 validation commands
must also pass from a Windows checkout with automatic line-ending conversion
enabled; the formatting gate is verified under that configuration.

**Local evidence (2026-09-10):** Windows/Node.js `v24.18.0` with
`core.autocrlf=true` passed `npm ci` and the complete `npm run check` production
path: 333 source tests passed, four gated tests skipped, the clean build and
tarball install succeeded, and the installed lifecycle and CLI help ran without
Python. The separately provisioned PTY contract remains CI-gated as documented.

## R1 — Build the real ApplicationService and composition root

**Status:** Complete for the listed Patch composition scope.
`ConcreteApplicationService` is the production root used by the CLI and composes
the supported main/weak/editor roles, staged application options, per-attempt
strategy prompts, provider lifetime, and documented terminal/watch/web policy.
This does not widen the provider, command, mode, or interface inventory to
Aider's full surface.

### Construction and startup

- [x] Implement a concrete `ApplicationService` and `ApplicationSession` as the
      sole owners of session construction and mutable application state.
- [x] Add one composition root that runs `bootstrapConfiguration`, loads the
      `ModelCatalog`, resolves the main model, constructs its provider and strategy,
      and opens filesystem/Git adapters.
- [x] Route every intended config-aware option through staged bootstrap. Model,
      file, Git, edit, check, history, multiline, notification, watch, and web
      controls resolve once with YAML/environment/dotenv/CLI precedence. The CLI
      passes that immutable result to application construction, and root-correction
      tests prove provisional interface values do not leak. Invocation-only message,
      editor, color, and completion controls intentionally remain CLI-only.
- [x] Remove `unavailableProvider` from the production path; fail before input
      starts with a secret-safe, actionable configuration diagnostic.
- [x] Add supported watcher and web startup around the concrete service.
      `--watch-files` starts Node watch around the terminal session with Git ignore
      handling; `--web --web-token-file` starts a separate authenticated loopback
      HTTP/SSE mode with the concrete service. CLI startup flags are opt-in, need
      no optional dependencies, and close resources on exit or startup failure.
      Evidence: `tests/interface-startup.test.ts` and packed concrete CLI-program
      startup in `scripts/package-smoke.mjs`. Full web operational policy remains R8.
- [x] Define complete cleanup for provider streams, watchers, subprocesses,
      histories, and web sessions. Session close aborts and drains active streams
      and process groups before closing `/model` providers; temporary weak providers
      close in `finally`; watch and web await all owned work and attempt independent
      cleanup after failures; history appends own short-lived descriptors. Provider
      construction occurs after fallible startup setup. Deterministic tests cover
      replacement, active shutdown, startup rejection, and aggregate cleanup.

### Context and strategies

- [x] Resolve all selected paths through `SafePathResolver`; reject mixed
      repositories and conflicting editable/read-only selections.
- [x] Build immutable per-turn snapshots and editable/read-only prompt chunks
      from current disk state.
- [x] Generate and inject repository maps when enabled, including current-turn
      filename and identifier hints.
- [x] Add a strategy registry for genuinely implemented modes and reject
      schema-only modes before a provider call.
- [x] Give each constructed strategy its canonical system prompt, examples,
      reminders, shell policy, and per-attempt fence. `ConcreteApplicationService`
      reconstructs the format prompt and updates `CoderSession`'s parser fence from
      current editable/read-only snapshots before every initial and reflected
      attempt. Production-path tests change selection without a profile switch and
      prove the new fence reaches context, examples, reminders, and parsing. Patch
      intentionally keeps English-only replies, unique-match rejection, explicit
      path/command approval, and transactional application.

**Acceptance:** the installed application service starts from supported
configuration, selects its providers/models/strategies, composes repository
context, and completes deterministic provider turns. The actual installed bin
also completes one-shot and two-turn OpenAI-compatible sessions against a
preloaded deterministic `fetch` fake, retaining the first exchange, with no
external network or live credential; malformed SSE fails nonzero without
leaking the fake's sentinel. Advanced role behavior is established separately
under R6; broader aider inventories are not part of this acceptance.

**Startup evidence:** `tests/application-service.test.ts`,
`tests/interface-startup.test.ts`, and `scripts/package-smoke.mjs` cover
application composition, watch/web startup and shutdown, installed fake-provider
startup, the default optional-dependency boundary, and executable help.
`tests/unified-diff.test.ts` retains the unique-hunk regression coverage. CI on
the pushed revision, rather than a frozen local test count, is the authoritative
verification result.

## R2 — Implement the correct end-to-end turn lifecycle

**Status:** Complete for every named mutation/cancellation boundary and
observer-atomic provider retry. The concrete application supplies per-attempt
resolution/application to `CoderSession`'s bounded loop; installed-service
acceptance demonstrates normal ordering and exact Git state, and deterministic
real-Git tests inject cancellation before and after mutation. The limits below
still prevent a full lifecycle-equivalence claim.
See [turn lifecycle](turn-lifecycle.md) for pinned sources and intentional
differences.

- [x] Refactor orchestration so every editing attempt executes in this order:
  1. compose current context and stream the provider response;
  2. parse and dry-run resolve the full edit batch;
  3. reflect on parse or application diagnostics within the configured bound;
  4. stage, preview, and authorize new/out-of-chat paths;
  5. checkpoint dirty selected files;
  6. apply the staged transaction;
  7. auto-commit changed files when enabled;
  8. lint changed files and optionally reflect, committing linter changes;
  9. preview and approve each model-suggested shell command;
  10. run configured tests and optionally reflect; and
  11. finalize history, usage, changed paths, and commit state.
      One deep-frozen attempt context carries the provider-visible snapshots and
      authorization sets through the entire callback; each reflection captures a
      fresh context. Configured failures reflect automatically within the bound,
      intentionally replacing Aider's interactive per-failure question.
- [x] Ensure lint and test commands observe the edited working tree, not an
      unapplied candidate.
- [x] Decide and document rollback behavior for a filesystem failure between
      multi-file writes; either implement checkpoint-backed restoration or correct
      the plan's unsupported atomic-rollback claim.
- [x] Preserve unrelated staged/unstaged changes through checkpoint, commit,
      failed check, cancellation, and undo paths. Real temporary repositories cover
      successful checkpoint/edit/check commits, failed hooks before and after a
      write, partial selected staging, unrelated staged plus unstaged content,
      untracked selected files, cancellation, and session-owned undo. Failed commit
      staging restores only saved selected index entries; arbitrary hook/command
      side effects and exotic index flags remain outside the guarantee.
- [x] Make cancellation at every boundary leave valid files, Git state, queue
      state, and reusable session state. A synchronous injected-boundary matrix
      covers context, provider, parse, resolution, preview, authorization,
      checkpoint, each atomic write/delete, edit commit, lint, model commands, test,
      reflection, and finalization against real temporary repositories. Completed
      writes and commits are retained and reported rather than rolled back.
- [x] Add one asymmetric end-to-end test that streams a malformed response,
      reflects, edits multiple files, commits, fails lint once, executes an approved
      command, passes tests, and undoes only the Patch commit.
- [x] Add denial, stale snapshot, partial-write failure, rejected command,
      timeout, truncation, and cancellation variants that assert exact disk and Git
      state—not merely emitted events.
- [x] Connect standalone interactive TTY authorization for new/out-of-chat
      writes and model commands without consuming queued/partial normal input.
      `tests/terminal-approval.test.ts` covers the concrete executable program path,
      strict answers, cancellation, exact file/process effects, and noninteractive
      gating. Watch/web/one-shot and other noninteractive contexts keep denial;
      native PTY approval coverage and broader approval policies remain incomplete.

**Acceptance:** met for final turn state, provider-retry observer consistency,
and documented Git outcomes. This is not pinned aider lifecycle equivalence or
a cross-process/durable rollback contract.

**Delivered evidence:** `scripts/lifecycle-smoke.mjs`, run against the clean
installed tarball by `scripts/package-smoke.mjs`, additionally includes a dry-run
resolution failure and a linter-created commit. It asserts two asymmetric file
contents, checkpoint/commit ancestry, unrelated staged and unstaged diffs,
refreshed prompt content, usage/history, and index-preserving undo. Approvals and
provider are injected into the installed service, not interactive bin prompts.
`tests/application-lifecycle.test.ts` adds real-Git failure variants, successful
and exhausted test reflection, live selection changes, and reusable queue
checks. Command timeout/output limits are shortened through the adapter for
deterministic tests; actual child execution is retained.

**Explicit limits outside R2 acceptance:**

- Standalone-bin approval acceptance is covered for the supported terminal
  policy separately from the installed-service lifecycle smoke. Configured
  lint/test reflection is deliberately automatic; there is no per-failure
  choice to leave the immutable attempt sequence half-entered. The successful
  path finalizes history, usage, changed paths, and latest commit correctly, and
  an interrupted turn whose edits survive reconciles history and reports a
  structured partial outcome. Each reflection round contributes its own answer
  exactly once: a round that fails before answering adds nothing, and the
  diagnostic it would have answered is dropped so history still ends on an
  assistant message.
- Unrelated-work preservation covers normal checkpoint, commit, failed
  hooks/checks, sampled cancellation, and undo with exact index/worktree
  assertions. Failure between undo's two Git commands, external processes, and
  arbitrary side effects of approved/configured commands remain outside the
  preservation guarantee.
- Cancellation at every named production boundary has deterministic injected
  coverage. Running Git/replacement operations finish; a partial write leaves
  completed files changed, reports each completed path and the latest turn-owned
  commit, preserves unrelated work, and releases the queue for a fresh-context
  retry. There is no cross-file rollback or durable journal. Arbitrary command
  side effects and interruption inside external Git remain outside this matrix.

## R3 — Dispatch every advertised slash command

**Status:** Every one of Patch's 28 named commands reaches a concrete effect.
Windows-safe path tokenization, bounded clipboard execution, and selected-file
`/diff` are covered; bare `/read-only` and aider's `!` alias remain unported.
Switching, undo ownership, bounded selection expansion, and ordinary command
result reporting remain production-wired.

- [x] Add an application-owned dispatcher for `/add`, `/attach`, `/drop`,
      `/read-only`, `/help`, `/settings`, `/report`, `/diff`, `/tokens`, `/map`, `/ls`, `/clear`,
      `/model`, `/chat-mode`, `/run`, `/web`, `/test`, `/lint`, `/commit`, `/undo`,
      `/copy`, `/paste`, and `/exit`.
- [x] Resolve and authorize command paths through the same containment boundary
      as model edits; never mutate session lists from raw parser strings.
- [x] Rebuild provider and the complete strategy/prompt state safely for
      `/model` and `/chat-mode`, preserving or summarizing compatible history. Both
      build a whole `SessionProfile` and install it only after the session accepts
      the switch; history drops media the replacement model cannot accept, and a
      history longer than the model's `maxChatHistoryTokens` is summarized before
      the next turn.
- [x] Add an interactive CLI approver for `/run`; `/lint` and `/test` use only
      configured process adapters at the repository root. `/run` shares the terminal
      approver used for model commands and writes; outside standalone interactive
      TTY mode it defaults to denial unless an embedding caller injects approval.
- [x] Constrain `/undo` to the current session's owned HEAD commit, selected
      paths, and supported ancestry/publication state without disturbing unrelated
      changes. Only the session's recorded commit is undone, root/merge/pushed
      commits are refused, and HEAD moves through a compare-and-swap.
- [x] Make `/copy` use text-only platform utilities and make `/paste` submit
      clipboard text as a user turn rather than an assistant-labelled response.
      Clipboard text becomes the turn message verbatim and is never reparsed as a
      command; clipboard images remain unread. Utilities have bounded input/output
      and duration, inherit session cancellation, terminate on failure, and release
      the queue after their direct child closes.
- [x] Serialize commands and provider turns through the same session queue and
      test commands submitted while a turn is active.

**Acceptance:** met only for registration, dispatch, and the exercised
next-turn cases. `tests/advertised-commands.test.ts` keeps the named inventory
equal to the parser/completion inventory and drives all 28 effects through one
real-Git concrete application, including safe failures. Focused tests separately
establish `/diff` privacy/bounds/sanitization, Windows path splitting, and
clipboard subprocess bounds. Aider
aliases/argument semantics and wider command breadth remain outside this
acceptance; those findings above control the current status.

## R4 — Add opt-in live provider contract tests

- [x] Add separately gated OpenAI and Anthropic tests using documented
      environment variables; add DeepSeek if it remains an advertised provider.
- [x] Exercise authentication diagnostics, a minimal streamed response, usage,
      finish reasons, timeout/cancellation, and one provider-specific capability.
      OpenAI and Anthropic have independent opt-in gates and credential checks. Each
      suite covers fixed secret-safe diagnostics, a positive-usage natural-stop
      stream, a one-millisecond SDK timeout, and a pre-aborted request; the successful
      OpenAI request carries a tiny PNG and Anthropic carries an ephemeral cache
      marker. Credential-free adapter tests cover the same failure contracts
      deterministically. Live success remains environment/account evidence rather
      than a default-CI guarantee.
- [x] Ensure missing credentials skip the live suite rather than failing normal
      CI and ensure failures never print keys, headers, or response secrets.
- [x] Run live tests on a manual or protected scheduled workflow with strict
      time and cost bounds; do not run them for untrusted pull requests.
- [x] Document API/network variability and distinguish mocked adapter tests from
      live contract evidence.
- [x] Normalize the advertised DeepSeek catalog model and request fields through
      the factory/session path used by the executable. Deterministic tests cover that
      path; the protected live case still constructs the adapter directly and is
      tracked in the current P2 evidence task.
- [x] Preserve OpenAI-compatible usage events that arrive with or after finish.
      Exposing accurate usage/cost at the application boundary is still P2.
- [x] Merge executable model metadata into settings and classify transient 5xx/
      validation failures consistently with the session retry policy. Catalog limits,
      prices, and capabilities reach session budgeting and accounting. Both adapters
      classify 408/409/429/5xx and malformed stream events consistently, discard raw
      provider diagnostics, and carry only a parsed delay from `Retry-After`. Header
      and local backoff delays cap at 60 seconds, attempts default to three and cannot
      exceed ten, and cancellation during backoff prevents a subsequent request.
      This intentionally hardens aider's unbounded blocking sleep while retaining its
      transient categories.

**Acceptance:** met for the documented OpenAI/Anthropic adapter contracts and
deterministic executable provider path. All three advertised providers have
protected catalog/factory/session live gates; successful credentialed evidence
remains P2.

## R5 — Add cross-platform CI and package evidence

- [x] Run format/lint/typecheck/unit tests once on Linux and run platform-sensitive
      integration/package jobs on Linux, macOS, and Windows with Node.js 22.
- [x] Cover path separators, symlinks or their documented Windows substitute,
      Git worktrees, process cancellation, shell argv, history permissions,
      external editor cleanup, notifications, clipboard detection, and package bins.
- [x] Run repository-map extraction for every shipped language from the packed
      package on all supported platforms. `scripts/package-smoke.mjs` extracts a
      real sample for each of the eleven shipped languages — JavaScript,
      TypeScript, TSX, Python, Go, Rust, Bash, C/C++, C#, Java, and Ruby — from the
      installed tarball and requires a definition tag from each, and the
      `Package and platform contracts` job runs it on Linux, macOS, and Windows.
- [x] Run explicit PTY tests only in jobs that provision the optional native
      dependency; verify Ctrl-C, EOF, resize, cleanup, and hostile split control
      sequences on Linux and Windows. macOS PTY is explicitly unsupported after the
      provisioned native package failed its spawn contract.
- [x] Add deterministic timeout guards and retain useful diagnostics without
      exposing environment secrets.

**Acceptance:** platform-sensitive Phase 6 and Phase 8 exit claims have green
Linux/macOS/Windows evidence or are narrowed to the platforms actually tested.
CI run
[`34987388922`](https://github.com/PierrunoYT/patch/actions/runs/34987388922)
passed all six Node 22, platform/package, and supported PTY jobs for
implementation revision `44dbae712d96cf6abdf65055d3b83ecdb9ec55e0`.

## R6 — Wire and verify advanced strategies

- [x] Keep user-facing mode schemas/settings aligned with the six constructed
      formats. `EditFormatSchema` is the one contract used by model settings,
      staged configuration, `/chat-mode`, and completion. Bundled editor settings
      name their actual parser (`diff`) rather than a helper-only alias. `help`,
      `udiff-simple`, `architect`, `editor-*`, and `context` fail at schema/parser
      boundaries before provider construction; architect/context identities remain
      private to read-only orchestration helpers. The pinned upstream format list is
      retained as evidence of Patch's intentionally narrower advertised subset.
- [x] Port distinct editor prompts and enforce editor-specific no-shell,
      no-repo-map, and fresh-history behavior where required by pinned Aider.
      `runEditor` constructs a new application session with the selected editor
      model/capabilities and current authorized paths, but no prior messages or map.
      It is serialized on the session queue like every other turn entry point; the
      architect already holds the queue when it hands work over, so it calls the
      unqueued body directly rather than taking the queue twice.
      Editor whole/diff/fenced-diff prompts remove shell/rename/go-ahead guidance;
      shell output is rejected through the production reflection path. Tests prove
      model routing, prompt/context shape, correction, cancellation-before-call,
      provider failure cleanup, unchanged files, and parent-session reuse.
      The selected local `/help` command is tracked separately; it does not require
      constructing Aider's model-backed help coder.
- [x] Integrate architect acceptance, fresh editor construction, state/cost/
      commit transfer, and final architect history through `ApplicationService`.
      `runArchitect` gives the current main model a read-only architect strategy and
      current history/context, records the completed proposal, and calls the
      acceptance callback before editor construction. Acceptance cancellation and
      denial make zero editor calls. A successful fresh editor transfers approved
      paths, both auxiliary costs, the editor commit, and pinned aider's final
      “I made those changes”/“Ok.” history pair. Real-Git production tests assert
      file/HEAD state, exact final messages, model requests, cost, denial, and
      cancellation.
- [x] Integrate context convergence with forced repository-map refresh, expanded
      initial map budget, complete replacement of selected files, and relevant
      identifier hints. `ApplicationSession.selectContext` uses the current main
      model/history and pinned context prompt, refreshes every pass with hints from
      the original request, and compares complete order-independent sets. It stages
      containment/ignore checks and approvals before every pass that would disclose
      a newly named file, not only before atomically replacing editable paths while
      retaining read-only paths; a path is asked about once, and an embedding with
      no approver is permitted to proceed, as it is for `/add`. Cancellation, denial, and a typed
      bounded non-convergence failure leave the parent selection unchanged.
      Production tests inspect both provider requests and map requests/budgets.
- [x] Schedule prompt-cache keepalive using only the cacheable prefix and
      verify failure/cancellation behavior. CLI, environment, and YAML expose a
      zero-through-ten ping opt-in defaulting to zero. Capable sessions replace the
      schedule on each accepted prompt, wait 295 seconds between one-token requests,
      stop at the final marker, swallow safe background failures, and abort timers
      and in-flight requests on replacement, switch, and session/application close.
      Deterministic fake-timer tests prove executable propagation, prefix exclusion,
      bounds, capability/opt-in/marker gating, and cleanup.
- [x] Complete repeated assistant-prefill continuation. Capable models make at
      most three follow-up requests, replacing one cumulative trailing prefill rather
      than appending duplicates. Deterministic core and executable tests prove three
      fragments assemble once, all usage/cost is aggregated, natural stop completes,
      and provider error or cancellation exits without committing partial history.
- [x] Integrate contained, size-limited image/PDF loading through application
      interfaces. `/attach` requires per-path approval and model capability before a
      no-follow cancellable read, validates allowlisted extension/signature pairs,
      rejects encrypted PDFs, and caps four files at 5 MiB each/10 MiB total. Fake
      provider tests prove image and PDF request parts while snapshots, histories,
      command results, and errors retain no bytes; `/drop` and close release context.
- [x] Add independent pinned golden fixtures plus asymmetric property tests for
      every advertised edit format, including switching away from incompatible
      protocol history. `tests/fixtures/edit-format-goldens.json` records one
      manually authored expected result, pinned revision, upstream path, and
      compatibility classification for each of the six constructed formats.
      `tests/edit-format-goldens.test.ts` checks asymmetric generated replacements,
      malformed output, ambiguous/conflicting targets, and exact completed-write
      state after injected failure or cancellation for all five mutating formats;
      `tests/coder-session.test.ts` covers incompatible-history removal. These are
      format-contract cases, not full upstream recovery parity.

**Acceptance:** met for the scoped advanced-workflow contract. Each listed
component is reachable from a constructed session and retains focused evidence;
physical-line Markdown-fence parsing and range-validated insertion-only hunks
also run through packed actual-bin smoke. This is not full aider mode or
edit-recovery parity.

## R7 — Integrate Phase 8 terminal behavior

**Status:** complete for the selected terminal contract. Completion, recall,
multiline, editor, notification, sanitizer, optional PTY, bounded clipboard, and
variable-length fence behavior are executable. True Vi modal editing, computed
previews, and broader Rich rendering are explicit non-goals, not open defects.

- [x] Connect command/file completion to the current command inventory and live
      selected paths; candidates follow `/add` and `/drop`.
- [x] Supply approved source-identifier candidates to executable completion.
      The session refreshes tracked non-ignored filenames and extracts identifiers
      only from current editable/read-only files on every Tab request. The async
      readline boundary does not receive source contents. Evidence:
      `tests/interface-startup.test.ts` and `tests/input-editing.test.ts`.
- [x] Load persistent input history for navigation and append input/chat records
      only after the correct lifecycle events; test explicit paths and disabled-by-
      default behavior. Recall is seeded only when `--input-history-file` is
      configured, and a damaged line is skipped rather than failing startup.
- [x] Apply Emacs/Vi bindings and external-editor invocation in the actual input
      loop rather than exposing declarative helpers only. Alt-Enter and Ctrl-X
      Ctrl-E are handled by the reader; Vi modal editing is refused instead of
      advertised, since Node readline cannot provide it.
- [x] Complete terminal output safety. One stateful sanitizer covers Markdown
      streaming, diff and preview rendering, Commander output, and executable
      failure messages, and it strips every claimed control-sequence family.
      Evidence: `tests/terminal-sanitizer.test.ts`.
- [x] Dispatch interactive commands through `runPtyCommand` only when explicitly
      requested and available; keep noninteractive process execution portable.
      `/run --interactive` is the only caller, the optional native package is loaded
      at that point and nowhere else, and an interface without a terminal refuses
      the command rather than running it unattached.
- [x] Generate shell completions from the real option surface, trigger
      notifications only for provider turns, and make clipboard paste submit text
      through the normal user-turn path. `generateShellCompletion` takes the
      inventory the parser registered instead of a list that drifted behind it;
      `ApplicationTurnResult.kind` distinguishes a provider turn from a slash
      command, so `--notifications` fires only for the former, and a failing
      notification command is reported rather than ending the input loop. Evidence:
      the completion, notification, and notifier-failure cases in
      `tests/cli.test.ts`.
- [x] Add terminal-level tests covering Ctrl-C recovery, EOF, resize, multiline
      submission, history navigation, editor cleanup, no-color output, hostile
      provider/child control sequences, and process cleanup. Ctrl-C now abandons the
      draft and every held line before the interrupt handler runs — readline emits
      `SIGINT` without touching the buffer, so an abandoned line used to reappear in
      front of the next one — and Ctrl-D on an empty line ends input. Evidence:
      `tests/input-editing.test.ts` (Ctrl-C, EOF, Alt-Enter submission, recall,
      editor round-trip and temporary-file cleanup, terminal handover),
      `tests/interactive-command.test.ts` (resize, child cleanup, hostile child
      sequences), `tests/render.test.ts` (no-color, hostile provider sequences), and
      `tests/terminal-sanitizer.test.ts`.

**Acceptance:** production reachability is met for the selected terminal
contract. Recall, multiline, Windows-safe editor splitting, bounded clipboard,
variable fences, explicit PTY dispatch, shell completions, and notifications are
executable; Rich rendering, computed previews, and Vi are non-goals.

## R8 — Expose Phase 9 adapters through ApplicationService

**Status:** complete for selected interfaces. Watch and local HTTP/SSE startup,
explicit `/web`, bounded sessions/replay/backpressure, contained reads, and the
optional voice adapter are wired. Browser GUI and CLI/device voice are
current-release non-goals; the API remains trusted-local only.

- [x] Feed fetched URL content through bounded application context with explicit
      user intent, source labeling, and token limits; keep Playwright separately
      installed and opt-in. `/web` is the only ingestion path, it fetches only the
      URL the user typed, and Playwright is neither installed by default nor used by
      the command.
- [x] Connect `AiWatchMode` to a concrete session and Git ignore checks.
      Terminal watch shares its session queue.
- [x] Coordinate repository mutations across independent web/application
      sessions that share one worktree. Every session created for one root shares
      the same mutation lock; `tests/worktree-serialization.test.ts` asserts that
      two sessions never interleave a mutation phase and that a conflicting
      concurrent write fails the losing turn instead of clobbering the winner.
- [x] Add supported startup/configuration for the authenticated loopback web
      server and construct it with the real `ApplicationService`. Interface choices
      are explicit CLI flags; model/file settings retain staged configuration.
- [x] Return a bounded, allowlisted partial-turn recovery result without
      exposing internal causes or command output. Concrete post-write failure tests
      verify that the response matches surviving disk state.
- [x] Define startup-failure and service-shutdown cleanup for HTTP/SSE sessions.
- [x] Define expiry, backpressure, bounded event buffering, quotas, and session
      reclamation. Defaults are 30-minute idle expiry, 32 total sessions, eight per
      principal, four pending messages and four SSE clients per session, a 256-event/
      256-KiB replay ring, and 128 KiB per slow client. Owners receive stable 410,
      409, or 429 codes; foreign principals still receive 404. Evidence:
      `tests/web-server.test.ts`.
- [x] Expose voice transcription as explicit input to an application session
      without importing voice code from the root/CLI path or requiring ffmpeg at
      install time.
- [x] Test principal/session isolation, simultaneous terminal/watch/web work,
      conflicting cross-session writes, disconnect cancellation, overflow,
      partial-failure consistency, and resource cleanup. The simultaneous test uses
      actual `AiWatchMode`, loopback HTTP, and direct terminal-style sessions over
      one `ConcreteApplicationService`; authorization overlap stays at one and all
      three writes survive. Evidence: `tests/web-server.test.ts`,
      `tests/interface-startup.test.ts`, and `tests/worktree-serialization.test.ts`.

**Acceptance:** watch, web, URL, and voice helpers drive real application
contracts rather than merely compiling against interfaces. This production
reachability and verified read containment do not close the ffmpeg-adapter
defect listed above or establish browser/CLI-voice parity.

## R9 — Correct stale plans and product documentation

- [x] Replace the stale source-baseline statement that Patch contains no
      implementation with an accurate component-versus-integration status.
- [x] Align the target `EditStrategy`, state-machine, queue, and application
      contracts in `PORTING_PLAN.md` with the chosen implementation boundaries.
- [x] Correct the recommended first slice: mark genuinely completed library work
      accurately and remove or implement the nonexistent saved-response dry-run CLI.
- [x] Rewrite README status claims that simultaneously call implemented modules
      absent and checked phases complete.
- [x] Re-audit every Phase 0–9 checkbox against production wiring and independent
      evidence. The 2026-09-12 audit checked all 78 boxes at Patch `bda2be474`, found
      no checked helper-only item, and split broad parity claims into precise open
      work without promoting Patch to full aider compatibility.
- [x] Correct Phase 3/5 lifecycle and usable-workflow exits after the immediate
      Git, move, undo, switching, paste, and history blockers were fixed. Both exits
      now describe the production-wired Patch contract and its non-transactional
      limits rather than requiring aider's per-failure prompt.
- [x] Correct Phase 6/7 parity claims. Advanced application roles and scoped map/
      edit recovery retain production evidence, but the 2026-09-15 audit reopens the
      Phase 7 exit for two P0 unified-diff defects. Both findings are now fixed with
      focused and packed-executable evidence, so the scoped Phase 7 exit is restored
      without claiming full aider parity.
- [x] Correct Phase 8/9 status after terminal, web, and optional adapter work.
      Variable fences, Windows tokenization, clipboard bounds, read containment,
      and ffmpeg pre-abort behavior are fixed; Rich/Vi, GUI, and CLI voice have
      explicit non-goal dispositions.
- [x] Reconcile `CHANGELOG.md` wording with executable behavior and current
      audit evidence, reserving “support” and “parity” for documented interfaces.
- [x] Establish a direct-derivation ledger and ensure every identified direct
      Aider source or shipped resource carries the required upstream path, revision,
      modification, and Apache-2.0 provenance. The automated scan rejects marker,
      ledger, per-file, and package drift while leaving generated fixtures on their
      independent blob-hash contract.
- [x] Add an independent pinned Git-tree inventory that classifies every aider
      product module, model resource, and Tree-sitter query. This complements rather
      than overstates the marker-driven direct-derivation ledger.

**Acceptance:** superseded by the deep `5eecc98` semantic audit. Audit,
inventory, matrix, plan, README, changelog, task register, and subsystem docs
are reconciled; remaining items are explicit external evidence or new findings.

## Continuous integration jobs

These are the exact jobs a claim may cite. A phase exit that names none of them
is backed by a local run, not by CI.

| Workflow / job                                                                   | Where it runs                                     | What it establishes                                                                                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml` → `check` (“Node.js 22”)                              | `ubuntu-latest`                                   | `format:check`, `lint`, `typecheck`, the whole test suite, the clean build, and `smoke:package` on one platform.                      |
| `.github/workflows/ci.yml` → `platform` (“Package and platform contracts”)       | `ubuntu-latest`, `macos-latest`, `windows-latest` | Platform-sensitive contracts, the clean build, the packed bin, and packed repository-map extraction for all eleven shipped languages. |
| `.github/workflows/ci.yml` → `pty` (“Explicit PTY dependency”)                   | `ubuntu-latest`, `windows-latest`                 | The provisioned `node-pty` contract. macOS is deliberately absent: the pinned native package fails its spawn contract there.          |
| `.github/workflows/live-providers.yml` → `live` (“Protected low-cost contracts”) | `ubuntu-latest`, manual/protected                 | Opt-in live provider contracts. It never runs for untrusted pull requests and skips without credentials.                              |

Current remote evidence is CI run
[`34987388922`](https://github.com/PierrunoYT/patch/actions/runs/34987388922)
on implementation revision `44dbae712d96cf6abdf65055d3b83ecdb9ec55e0`:
all six Node 22, platform/package, and supported PTY jobs passed.

The fixture exporter is not a CI job: `npm run fixtures:upstream` needs the
pinned aider checkout and its Python environment. It refuses a checkout whose
remote, commit, or working tree differs from `upstream.json`, including a dirty
tree and any listed source whose blob hash has moved. CI checks the manifest
against the driver's explicit direct imports through
`tests/upstream-fixtures.test.ts`, without Python or an upstream checkout. It
also runs the exporter against a temporary Git repository to verify rejection
of status-hidden source changes. Transitive imports/resources remain outside
the direct-import coverage claim.

## Verification commands and required evidence

Run these from a clean checkout with Node.js 22:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:package
npm start -- --help
```

Before claiming the MVP/session exits, also run targeted integration tests that
cover:

- [x] packed CLI startup with config, dotenv, environment, and CLI precedence
      (`scripts/package-smoke.mjs` invokes the actual installed bin four times,
      checks the safe effective model/mode/encoding, makes no provider turn, and
      rejects leakage of an unrelated environment secret);
- [x] actual-bin one-shot and multi-turn deterministic-provider sessions
      (`scripts/package-smoke.mjs` preloads an in-process `fetch` fake into the
      installed bin, verifies first-exchange retention on the second request, and
      safely rejects malformed SSE; it uses no socket, external network, or live
      credential);
- [x] edit preview, authorization denial/acceptance, dirty checkpoint, apply,
      commit, lint, approved shell command, test reflection, and owned undo
      (`scripts/lifecycle-smoke.mjs` exercises the installed service and
      `tests/terminal-approval.test.ts` separately covers executable TTY approval);
- [x] exact file and Git state after cancellation or every named injected
      lifecycle failure (`tests/application-lifecycle.test.ts` and
      `tests/edit-format-goldens.test.ts`);
- [x] every named Patch slash command through its exercised application effect
      (`tests/advertised-commands.test.ts` asserts exact docs/parser inventory
      equality and executes all 28 effects in a real temporary Git repository,
      including safe containment, denial, refused URL ingestion, and missing-state
      paths; focused tests separately cover Windows path tokenization, clipboard
      bounds, and `/diff`; aider aliases/argument semantics remain outside scope);
- [x] tag extraction from the installed package for every shipped language
      (`scripts/package-smoke.mjs`), not every-language provider-context parity;
- [x] filtered ranked repository-map context through an actual installed-bin
      provider turn, including exclusion of a tracked `.aiderignore` match
      (`scripts/package-smoke.mjs`);
- [ ] credentialed OpenAI and DeepSeek production-route evidence, the same
      single blocker tracked in `task.md`; Anthropic passed locally, OpenAI was
      rate-limited, and no DeepSeek credential was available;
- [x] green Linux, macOS, and Windows package/platform jobs for implementation
      revision `44dbae712d96cf6abdf65055d3b83ecdb9ec55e0` in run
      [`34987388922`](https://github.com/PierrunoYT/patch/actions/runs/34987388922);
- [x] default packed installation with no native/browser/audio dependency; and
- [x] explicitly provisioned PTY suites on Linux and Windows in run
      `34987388922`, plus credential-free optional-interface loopback suites in the
      Node 22 job.
- [x] no real-device evidence requirement for current release scope: CLI voice
      and browser GUI are non-goals, and helper/loopback tests are not presented as
      device or browser evidence.

Record the exact test files/workflows next to each corrected phase exit. A green
unit test for an exported helper is evidence for that helper, not for an
installed-application parity claim.
