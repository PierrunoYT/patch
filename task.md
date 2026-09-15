# Patch issue and task register

## Purpose

This is the consolidated queue for unresolved Patch work. It combines the
[current parity audit](docs/aider-parity-audit-2026-09-15-cee39ed.md), its
[source inventory](docs/aider-source-inventory-2026-09-15-cee39ed.md), and the
[detailed integration backlog](docs/remaining-integration-tasks.md).

The parity audit compares branch behavior inside the owning aider/Patch modules;
the source inventory classifies every pinned product file. Earlier dated audits
remain historical snapshots. Update this file, detailed evidence, and affected
subsystem docs together.

Baseline for the current findings:

- Patch source: `cee39ed41330eca755b9c7c65084abccefce90aa`
- aider source: `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`
- Complete upstream inventory: 80 Python product modules, two model resources,
  58 Tree-sitter queries, 36 executable tests, and ten workflows

## Working rules

- P0 items are release blockers. Fix them through the installed production path
  before claiming the affected phase complete.
- Preserve Patch's ambiguity rejection, explicit path/write/command approval,
  process bounds, literal Git paths, session-owned undo, verified TLS, bounded
  explicit networking, and opt-in persistence. Upstream behavior is not a
  reason to weaken these controls.
- Treat model output, configuration, paths, subprocesses, and network responses
  as untrusted input. Test malformed input, cancellation, partial failure, and
  containment where applicable.
- Use deterministic providers and temporary real Git repositories in the
  default suite. Keep live credentials out of tests and diagnostics.
- A task is complete only when its documented executable path, focused tests,
  package/installed-path evidence where relevant, and documentation are all
  updated. Run `npm run check` before completion.
- Keep Patch's accepted non-goals: no Python/aider runtime, analytics,
  automatic onboarding/OAuth, implicit provider metadata networking, built-in
  updater, or Docker-distribution parity.

## Resolved P0 release blockers

- [x] **UDIFF-1: Preserve Markdown fence lines inside unified-diff hunks.**
      Line-anchor the response-fence terminator so added and context lines that
      contain triple backticks remain diff data. Cover added, removed, and retained
      fences in parser and installed-turn tests. Completed with physical-line fence
      scanning and packed executable coverage.
- [x] **UDIFF-2: Apply insertion-only hunks at a validated location or reject
      them.** Numeric `@@` ranges are retained for empty-preimage edits, checked
      against hunk counts and preceding validated-insertion offsets, and bounded
      against the current snapshot. Missing, inconsistent, and out-of-file
      locations fail closed.
      Beginning, middle, end, repeated text, new-file, existing-empty-file, and
      installed middle-insertion cases are covered.

## Deep-audit correctness fixes

- [x] **CTX-1: Deny model-selected context disclosure without an approver.**
      `selectContext` now fails before a newly selected file reaches the next pass.
- [x] **SWITCH-1: Forward cancellation into switch-time summarization.** Model,
      mode, reasoning, and thinking switches preserve the prior profile/history.
- [x] **PROMPT-2: Honor model prompt placement settings.** Construction now
      supports no-system preambles, system examples, model-selected reminder roles,
      and pinned read-only/repository acknowledgements.
- [x] **MAP-4: Retain containment through map source reads.** Tag extraction and
      rendering use verified handles, reject ancestor swaps, and cap reads at 4 MiB.
- [x] **CONFIG-4: Bound startup resource files.** Config, dotenv, and custom
      model resources use race-safe 1 MiB reads before parsing.
- [x] **PROC-2: Await Windows command-tree termination.** Timed-out/cancelled
      commands settle after `taskkill /T /F`, not direct-child close alone.
- [x] **WEB-2: Bound explicit URL command input.** `/web` rejects URLs over
      4,096 characters before network parsing or dispatch.

## P1 — supported-surface correctness and safety

- [x] **PATCH-2: Require a complete Patch response envelope.** Reject a missing
      `*** Begin Patch`, missing `*** End Patch`, and successfully truncated action
      output instead of applying the partial batch. Pinned aider tolerates these
      cases; Patch now fails closed, reflects through the normal lifecycle, and
      covers the behavior in parser, session, and packed lifecycle tests.
- [ ] **MODEL-8: Derive history budgets from model context size.** Match pinned
      aider's 1/16 input-window rule clamped to 1,024–8,192 tokens rather than
      summarizing every bundled model at 1,024 tokens.
- [ ] **TOKEN-1: Make fallback token enforcement genuinely conservative.** The
      current UTF-16-length/4 estimate can undercount CJK and other inputs. Use a
      safe refusal bound or stop presenting the approximation as a protective
      preflight limit.
- [x] **FS-2: Retain containment and bound general text reads.** Read editable,
      read-only, completion, and transaction snapshots through a verified handle
      with a byte ceiling; static resolution followed by `readFile(path)` permits
      an ancestor swap and unbounded allocation. Completed with retained-handle
      reads, a fixed 4 MiB ceiling enforced during chunked reads, deterministic
      ancestor-swap coverage, and oversized read/write-preparation regressions.
- [ ] **MAP-5: Enforce the map source limit before cache hashing.** The tag cache
      currently reads and hashes the whole file before the extractor applies its
      4 MiB ceiling.
- [ ] **PROC-3: Bound interactive PTY transcript capture.** Stream sanitized
      output while capping retained result bytes and terminate/drain cleanly on
      overflow or cancellation.
- [ ] **WEB-3: Reserve session quota atomically across async creation.** Count
      in-flight reservations so concurrent requests cannot exceed global or
      per-principal limits, and release reservations on every failure path.
- [ ] **WEB-4: Keep nested discarded HTML out of model context.** Track nested
      script/style/media elements; the current single-name state can expose text
      after the first nested closing tag.
- [ ] **VOICE-3: Force-settle active ffmpeg cancellation.** Escalate after a
      grace deadline when the recorder child ignores `SIGTERM`; the existing
      pre-abort check does not bound an active abort.

- [x] **CORE-1: Make provider retries observer-atomic.** Buffer each attempt's
      text, reasoning, and error events until it succeeds, or add a reset protocol
      implemented by every terminal and HTTP/SSE consumer. Failed-attempt output
      must not appear as accepted turn output when history and edit parsing retain
      only the successful attempt. Completed 2026-09-15: `CoderSession` now buffers
      every validated event per provider attempt and forwards it only after an
      accepted finish; focused session and concrete application tests prove stale
      text, reasoning, usage, and retry errors never reach result/interface events.
- [x] **MODEL-1: Align bundled model role defaults.** `gpt-4o-mini` now uses
      pinned aider's `whole` format without a repository map, and DeepSeek Reasoner
      routes weak/editor work to DeepSeek Chat. Exact catalog, selection, and
      production summary/editor tests cover the bundled profiles.
- [x] **MODEL-2: Reconcile bundled DeepSeek token limits.** Both DeepSeek
      profiles now use pinned aider's 128,000-token input limit; Chat retains 8,192
      output tokens and Reasoner uses 64,000. Exact catalog assertions and concrete
      provider requests cover the load-bearing values.
- [x] **WIN-1: Preserve Windows backslashes in command and editor tokenizers.**
      Fix slash-command paths and configured external-editor commands together.
      Cover drive paths, UNC paths, relative paths, spaces, quotes, and literal
      backslashes without regressing POSIX escaping. Completed 2026-09-15: both
      consumers use one quote-aware word splitter that preserves separators before
      ordinary characters and UNC prefixes while retaining POSIX whitespace, quote,
      and literal-backslash escapes; focused tests cover every listed form.
- [x] **PROC-1: Bound and cancel clipboard utility subprocesses.** Limit time
      and read/write bytes, forward cancellation, terminate and drain children, and
      prove a hung or overproducing utility cannot hold the serialized session
      queue. Completed 2026-09-15: clipboard utilities default to a 10-second and
      1-MiB boundary, reject oversized input/output, receive session cancellation,
      terminate their process tree, and settle only after the direct child's stdio
      closes. Executable and serialized-queue tests cover timeout, output overflow,
      cancellation, cleanup, and queue reuse.
- [x] **FS-1: Retain containment across media and watch reads.** Prevent an
      ancestor swap between canonical resolution and read/open from redirecting
      content outside the repository. Add deterministic race tests. Pinned aider is
      not stronger; this is intentional Patch hardening, not mimicry. Completed
      2026-09-15: both paths retain a no-follow file handle only after re-resolving
      the target and verifying its opened identity plus every in-root ancestor;
      deterministic pre-open swaps prove media fails and watch submits nothing.

## P2 — bounded correctness follow-ups

- [ ] **PROC-4: Bound external-editor readback and define cancellation.** Keep
      interactive editing duration distinct from a byte ceiling on the returned
      draft, and document how an embedding can stop a stuck editor.
- [x] **DOC-1: Settle slash-command transcript policy.** The opt-in Markdown
      transcript intentionally records every submitted command and returned string;
      `/help` documentation now matches the generic terminal recorder and
      distinguishes the transcript from provider-ready history.
- [ ] **EVIDENCE-4: Close CI/package evidence gaps.** Run the provenance check in
      ordinary CI and make package smoke assert declarations plus the root public
      package export. These are evidence gaps, not observed runtime failures.

- [x] **TERM-1: Preserve language identifiers on variable-length Markdown
      fences.** The stream tracks the opening run length and language, accepts only
      an at-least-matching bare close, and handles openings/closings split across
      chunks. Focused tests cover highlighting and shorter nested runs.
- [x] **VOICE-1: Honor pre-aborted signals in `FfmpegVoiceRecorder`.** The
      exported adapter checks cancellation before spawning; a real subprocess test
      proves a pre-aborted call creates no child side effect or abort listener.
- [x] **CORE-2: Settle close-only reasoning display behavior.** Attempt
      buffering now reclassifies a prefix before publishing accepted events, so
      display, result, continuation, history, and parsing retain one normalized
      answer. Stream-contract tests cover split close tags and continued output.

## Release and compatibility evidence

- [ ] **EVIDENCE-1: Obtain successful credentialed OpenAI and DeepSeek
      production-route evidence.** Anthropic's catalog/factory/application-session
      turn passed with positive usage. Repeated OpenAI attempts reached transport
      but the available account was rate-limited, and no DeepSeek credential was
      available. Deterministic full-path gates cover all three providers but are not
      live evidence.
- [x] **EVIDENCE-2: Obtain current-revision Node 22 package evidence on Linux,
      macOS, and Windows.** CI run
      [`34987388922`](https://github.com/PierrunoYT/patch/actions/runs/34987388922)
      passed the Node 22 suite, packed executable and all eleven map languages on
      Linux/macOS/Windows, and provisioned PTY contracts on Linux/Windows for
      implementation revision `44dbae712d96cf6abdf65055d3b83ecdb9ec55e0`.
- [x] **EVIDENCE-3: Require real-device evidence only for optional interfaces
      selected for release.** No microphone/CLI voice or browser GUI is selected;
      browser-rendered `/web` is a non-goal. Retain fake-adapter and loopback API
      evidence without relabeling it as device/browser evidence.

## Product-scope decisions and parity work

These are not all release blockers. Decide each item before implementation,
record an explicit implemented/deferred/non-goal disposition, and preserve the
security rules above.

### Providers and models

- [x] **MODEL-3:** Keep the current release provider boundary to OpenAI,
      Anthropic, and DeepSeek. Unnamed LiteLLM-compatible breadth is not a support
      claim; reopen expansion only for a selected provider with explicit
      credentials, capability contracts, deterministic tests, and opt-in live
      evidence.
- [x] **MODEL-4:** Expose safe executable model discovery and custom catalog
      overlays. Repeatable CLI files override singular environment files and YAML
      arrays by resource kind; all resolve from the invocation directory and are
      bounded and strictly validated before startup. `--list-models [query]` and
      `/models [query]` render only bounded canonical name/provider/edit-format
      summaries and make no provider or network call.
- [x] **MODEL-5:** Add capability-gated reasoning-effort and thinking-token
      controls. Startup and mutable commands use strict values, omit temperature,
      and map only declared custom OpenAI reasoning effort or Anthropic thinking
      budgets to typed adapter fields. Unsupported model/provider combinations fail
      before transport; no bundled model overclaims either mutable capability.
- [x] **MODEL-6:** Select and switch main, weak, and editor models independently.
      Startup roles use staged precedence; `/weak-model` and `/editor-model` resolve
      and validate before serialized assignment. Main profile/history/media remain
      intact, editor work stays fresh and isolated, summarization/commit generation
      use the current weak role, and secondary usage remains session-accounted.
- [x] **MODEL-7:** Expose prompt-cache markers independently from bounded
      keepalive. `--cache-prompts`/`--no-cache-prompts`, `PATCH_CACHE_PROMPTS`, and
      `cache-prompts` YAML use normal CLI-over-environment-over-file precedence.
      Markers remain enabled by default for capable models to preserve Patch's
      existing foreground behavior; disabling them also suppresses a configured
      keepalive schedule. Focused bootstrap, session, and production application
      tests cover precedence, marker removal, and the no-background-request path.

### Edit strategies and orchestration

- [x] **EDIT-1:** Keep `udiff-simple` out of Patch's public format set. Pinned
      aider reuses the same unified-diff parser with a shorter reminder and no
      examples; it adds no parsing capability beyond Patch's constructed `udiff`.
      Maintaining a second public prompt identity would widen schemas, fixtures, and
      support claims without distinct behavior.
- [x] **MODE-1:** Keep architect and context as embedding-only application
      workflows for the current release. Their callback contracts preserve explicit
      plan/path approval and cancellation, but the terminal has no complete
      proposal-review or convergent-selection UX. Public aliases would overclaim
      recovery and installed-bin support.
- [x] **MODE-2:** Summarize completed history before an incompatible model or
      chat-mode switch. The current weak model performs bounded compaction; failure
      leaves the old profile/history active. Media unsupported by the replacement
      is filtered only after a valid summary, and usage stays session-accounted.
- [x] **PROMPT-1:** Keep byte-level prompt and automatic localization parity out
      of Patch's current product contract. Production prompts remain shorter and
      English-only; compatibility fixtures prove format-specific structure, chunk
      order, fence interpolation, and parser behavior rather than exact prose.
      Reopen localization as a separately designed feature only when public modes
      and language precedence are specified.

### Commands and executable workflows

- [x] **CMD-1:** Keep the read-only inspection surface to `/settings`, `/diff`,
      `/tokens`, and `/map`. `/map-refresh` is redundant because `/map` already uses
      fresh tracked/non-ignored production inventory. `/copy-context` would disclose
      raw prompt, history, file, map, and media content to an ambient OS clipboard;
      users can inspect bounded numeric/map/diff views without that side effect.
- [x] **CMD-2:** Keep exact slash-command names and arguments as the current
      contract. Do not add `!`, bare `/read-only`, `/reset`, `/ask`, `/code`, `/ok`,
      `/multiline-mode`, or `/quit`: existing `/run`, explicit path lists, `/drop`
      plus `/clear`, `/chat-mode`, startup multiline configuration, and `/exit` make
      them redundant, while aliases obscure approval or combine state transitions.
- [x] **CMD-3:** Keep `/git`, `/load`, `/save`, `/editor`, and `/edit` out of the
      command surface. `/run git ...` already provides visible approval and bounded
      execution; command files create hidden compound effects; interactive draft
      editing already uses Ctrl-X Ctrl-E. Adding aliases would duplicate paths or
      weaken per-effect authorization, containment, cancellation, and queue clarity.
- [x] **CMD-4:** Keep offline saved-response and clipboard edit application out
      of Patch: model edits must pass through the composed snapshot, preview,
      authorization, transaction, Git, and recovery lifecycle. A startup-only
      `--exit` debug flag is redundant with Patch's one-shot modes. Read-only prompt
      and repository-map diagnostics remain tracked by `CMD-1` and `MAP-2` instead
      of duplicating those decisions here.
- [x] **CMD-5:** Do not track model commands as a separate implementation item.
      `/models` belongs to `MODEL-4`, reasoning/thinking controls to `MODEL-5`, and
      weak/editor model commands to `MODEL-6`; each command may be exposed only with
      its capability, validation, atomic switching, and provider tests. This closes
      the duplicate low-priority alias task without claiming those P2 controls.

### Configuration, history, terminal, and clipboard

- [x] **CONFIG-1:** Keep persistence to explicit input recall and rendered chat
      history files. Do not restore model history, log provider wire payloads, or
      load/save command files: those retain secrets/raw media or replay effects.
      Existing history is opt-in, owner-private where supported, append-only,
      corruption-tolerant for recall, unredacted, and user-retained/deleted.
- [x] **CONFIG-2:** Keep executable line endings on `preserve`. Existing files
      retain their first observed style; new/no-newline files use the platform
      default. Global LF/CRLF conversion remains a library option, not a CLI/config
      control, because a session-wide override can rewrite unrelated selected files
      and inflate diffs without an explicit per-file conversion workflow.
- [x] **CONFIG-3:** Keep the executable encoding contract to UTF-8, UTF-16LE,
      and Latin-1. These codecs have fatal decode or exact representability checks,
      round-trip writes, BOM retention where applicable, and newline tests.
      Arbitrary Python/ICU codec names are a non-goal because their availability
      and encode/decode behavior would make the npm package platform-dependent.
- [x] **TERM-2:** Keep streaming always on and terminal presentation limited to
      automatic TTY/`NO_COLOR` detection plus `--no-color`. Pretty/raw toggles,
      palette/theme controls, completion colors, and diff-display switches are
      non-goals for the dependency-free renderer; they multiply unsupported visual
      states without changing the safe text contract.
- [x] **TERM-3:** Keep computed edit-preview hunks, Rich-style Markdown, and true
      Vi input out of the current terminal. They require a replacement renderer and
      line editor, not independent toggles; the existing full-content preview,
      dependency-free streaming renderer, Ctrl-X Ctrl-E, sanitizer, and approval
      boundaries remain the supported coherent contract.
- [x] **CLIP-1:** Keep clipboard access text-only. Patch will not silently probe
      the OS clipboard for images or create out-of-repository temporary media;
      images and PDFs enter model context only through an explicit, visible
      `/attach <path...>` command using the bounded, approved, contained media path.
- [x] **SHELL-1:** Keep generated completion to Bash, Zsh, and Fish, the shells
      with deterministic maintained tests. Keep shell-suggestion policy bound to
      the selected edit strategy and interactive input on the single Node readline
      implementation; neither changes the requirement to preview and approve model
      commands. Wider shell support and alternate line editors are non-goals for the
      current terminal contract.

### Repository maps, Git, recovery, and checks

- [x] **MAP-1:** Keep the shipped eleven repository-map language entries as the
      current release set. Unsupported languages still contribute bounded lexical
      references, so speculative breadth is unnecessary. Add a language only from a
      concrete user requirement, with its pinned query/grammar, tag fixture, cache
      fingerprint, extraction tests, and packed cross-platform evidence.
- [x] **MAP-2:** Keep map sizing, refresh, and empty-chat multiplier
      model-derived and internal. `/map` is the sole display control and already
      uses fresh production inventory. Public tuning would expose cache/ranking
      implementation details, destabilize prompt budgets, and multiply unsupported
      configurations without a demonstrated operational need.
- [x] **MAP-3:** Treat exact arbitrary-program and every-language ranking parity
      as an unbounded non-goal. Patch's contract is evidence-scoped: each selected
      language needs pinned tags and packaged extraction, representative independent
      ranking/rendering fixtures, strict token ceilings, and unreadable-file
      isolation. Language and map-control expansion remain under `MAP-1`/`MAP-2`.
- [x] **GIT-1:** Keep Git controls to the existing composed policy: fixed
      `.aiderignore` plus Git ignores, mandatory Git-enabled checkpoint/auto-commit,
      configurable hook verification, explicit attribution, bounded generated
      subjects, selected `/commit`, and session-owned `/undo`. Custom ignore paths,
      subtree modes, ignored-file bypass, independent commit toggles, prompt/language
      controls, and repository-sanity bypasses are non-goals because they weaken or
      fragment established safety invariants.
- [x] **RECOVERY-1:** Keep recovery process-local and explicit for the current
      release. Patch reports surviving paths/commits/commands, reconciles history,
      reuses the queue, and protects in-process worktrees. A durable journal,
      cross-process lock, rollback of completed writes, Git interruption, or
      arbitrary approved-command side effects would require a new transaction
      architecture and cannot be promised safely by the current adapters.
- [x] **CHECK-1:** Keep linting and testing to one explicitly configured command
      each. Do not infer package-manager or language-specific tools, compile source
      implicitly, or bundle linters: repository scripts encode project-specific
      flags and environments, while guessed execution creates unapproved side
      effects and platform-dependent behavior.
- [x] **CHECK-2:** Keep noninteractive execution to `--message` and
      `--message-file` through the normal lifecycle. Do not add global dry-run,
      one-shot commit/lint/test flags: dry-run cannot cover arbitrary hooks or child
      effects, while `/commit`, `/lint`, and `/test` already provide serialized,
      explicit outcomes. Dedicated flags would duplicate semantics and invite false
      no-write guarantees.

### Optional interfaces and provenance

- [x] **GUI-1:** Keep a browser GUI out of the current release. The authenticated
      loopback HTTP/SSE server remains an API for trusted local clients, not a UI.
      A GUI would add a second approval surface, secret/token storage, session
      lifecycle/reconnect UX, browser security, and shared-worktree interaction; no
      concrete product requirement justifies that permanent surface now.
- [x] **VOICE-2:** Keep voice as an optional embedding-only package subpath.
      Do not add CLI microphone/device UX: it would require cross-platform device
      selection, optional ffmpeg packaging, transcription-provider disclosure,
      transcript review before submission, and real-device/network evidence. The
      recorder/transcriber contracts remain available to hosts that own those
      choices; active ffmpeg termination is tracked separately in `VOICE-3`.
- [x] **WEB-1:** Keep URL ingestion explicit, DNS-pinned, bounded, and
      no-subresource. Production browser rendering and automatic URL detection are
      security/privacy non-goals unless a separate threat model and approval
      boundary are designed.
- [x] **PROVENANCE-1:** Keep three explicit evidence boundaries: the
      direct-derivation ledger for attribution, the dated Git-tree inventory for
      upstream-source completeness, and direct-import hashes for fixture
      regeneration. Recursive Python import and blanket resource hashing are not
      Patch runtime or semantic-parity guarantees.

## Completion update template

When checking an item, record in the same change:

1. the behavior and intentional differences;
2. source files and production composition path;
3. focused tests, failure/cancellation/containment cases, and installed-path
   evidence where applicable;
4. `npm run check` result and any unavailable platform/live evidence;
5. updates to this register, the detailed backlog, `PORTING_PLAN.md`, affected
   feature docs, `README.md`, and `CHANGELOG.md`; and
6. the Patch and pinned aider revisions used for parity claims.
