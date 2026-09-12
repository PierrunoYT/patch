<p align="center">
  <img src="assets/logo.svg" alt="Patch wordmark" width="300">
</p>

<h1 align="center">Patch</h1>

<p align="center">
  <strong>AI pair programming in your terminal.</strong>
</p>

<p align="center">
  <a href="https://discord.gg/sk9Q28VnYG">
    <img src="https://img.shields.io/badge/Discord-Join%20community-5865F2?logo=discord&amp;logoColor=white" alt="Join the Patch Discord community">
  </a>
</p>

Patch is an early-stage TypeScript port of [Aider](https://github.com/Aider-AI/aider),
using Node.js and npm. The goal is to bring Aider's terminal coding workflow to
TypeScript while preserving upstream attribution under Apache-2.0.

## Project status

Patch is an unreleased, incomplete port with a working but pre-release core
application path. The `patch` executable bootstraps configuration, constructs
OpenAI or Anthropic routes, builds editable/read-only/repository-map context,
and runs serialized one-shot or line-oriented interactive turns. A DeepSeek
route normalizes the catalog model name, output limit, and prefill request for
that endpoint. Packed-install smoke tests invoke the actual installed binary and
verify YAML, process environment, dotenv, and CLI precedence through `/settings`;
placeholder credentials never reach a provider or the output.
The same installed-bin smoke uses an in-process deterministic OpenAI-wire fake
that replaces `fetch`, so one-shot and two-turn history behavior run with no
external network or live credential. A malformed fake stream must fail safely.
Separately gated, credential-optional live OpenAI and Anthropic contracts cover
minimal streaming, usage, stop reasons, timeout/cancellation, and one native
capability; ordinary CI remains credential-free and offline.
Resolved catalog metadata supplies executable limits, capabilities, and pricing.
Transient 408/409/429/5xx and malformed streams retry at most three attempts;
validated `Retry-After` delays and exponential backoff are capped at 60 seconds
and cancellation interrupts backoff.
The six constructed formats are `ask`, `whole`, `diff`, `diff-fenced`, `udiff`,
and `patch`. Each receives its pinned format-specific system instructions,
examples, reminder, shell policy, and a fence reselected from the current files
before every provider attempt. Each format also has an independently authored
pinned golden plus asymmetric property, malformed, ambiguity/conflict,
partial-write, and cancellation evidence. Broader unified-diff recovery remains
incomplete; constructed formats are not a release-readiness claim.
Selected-file edits are dry-run resolved, previewed, written, optionally
committed, and followed by explicitly configured lint/test commands. Parse,
resolution, and post-write check failures share a three-reflection budget with
fresh disk context between attempts. Slash commands dispatch through the same
session queue. See [turn ordering and recovery](docs/turn-lifecycle.md) for
the installed acceptance evidence and intentional differences from aider.
The parser-owned inventory and `docs/commands.md` are checked against each other,
and one real-Git application scenario executes all 20 advertised command effects
plus contained/denied/missing-state failures. This proves the advertised Patch
surface, not aider's wider command set.

Commit policy is configurable through CLI, YAML, and `PATCH_*` values.
`--git-commit-verify` enables repository hooks;
`--generate-commit-messages` opts into bounded weak-model requests over selected
diffs. `--commit-author-name`, `--commit-committer-name`, and
`--commit-co-author` set explicit attribution. Defaults retain fixed messages,
Git's `--no-verify`, and unchanged identity; `/commit <message>` never needs a
generation call. Hooks are not sandboxed, and generation adds provider cost.
See [commit policy and recovery](docs/git-repository.md#production-commit-policy)
for exact attribution scope, limits, and intentional differences from Aider.

Standalone interactive sessions with TTY input and output ask before each
new/out-of-chat write, model-suggested shell command, and `/run` command.
Prompts show exact JSON-quoted paths/commands; only `y` or `yes` (case-insensitive)
approves. Enter, other answers, EOF, and Ctrl-C deny; Ctrl-C stops the CLI.
Queued or partially typed input is preserved as normal input and causes denial,
never approval. Answers are not submitted to the model or persistent history.
Commands are not sandboxed; literal secrets in commands are visible in their
preview, but approval does not expand environment variables or print credentials.

One-shot, piped/non-TTY, redirected-output, `--multiline` (EOF input), watch
(including its terminal session), web, and injected-line sessions do not install
approvers. Embedding callers must explicitly inject approval callbacks.
Selected-file edits and configured lint/test commands retain existing behavior.
File-mention selection and per-failure reflection prompts remain unsupported.

This is not yet a usable-release or Aider-parity claim. Repository mutations are
serialized across every session sharing a worktree, all untrusted terminal
output passes through one stateful control-sequence sanitizer, and replacement
preserves the metadata Node can carry portably while refusing a swapped ancestor;
`/model` and `/chat-mode` rebuild the whole model profile atomically, `/paste`
submits clipboard text as a user turn, and a turn interrupted after its edits
landed reconciles history and reports surviving work through the terminal.
Historical checklist completions do not establish release readiness. The latest
[parity audit](docs/aider-parity-audit-2026-09-11.md) identifies open
findings at its audited revision. The
[live backlog](docs/remaining-integration-tasks.md) reconciles completed fixes,
remaining integration work, and planned commands.
The direct fixture-import hash gap is now closed: all twelve imports are pinned,
with import-derived coverage and status-hidden-change tests. This does not
establish transitive dependency or resource integrity; see the
[fixture provenance boundary](docs/compatibility-fixtures.md#what-the-exporter-refuses).
Hardlinked and non-regular mutation targets are rejected rather than replaced
or deleted.
Failure/cancellation coverage is not exhaustive. Multi-file failures retain
completed writes rather than rolling back; a move writes and syncs its
destination before removing its source, so an interrupted move keeps both paths.
`/undo` retains working files and unrelated staged changes, reverts only the
commit the current session created, and refuses a moved HEAD or a commit its
upstream branch already contains.
Failed checkpoint/edit/check commits likewise restore selected paths to their
prior index entries, including partial staging, while retaining working-file
content and unrelated staged/unstaged changes.
Cancellation is checked at every editing lifecycle boundary. Completed atomic
file replacements and Patch commits remain valid and are reported explicitly;
pending edits are cleared and the same session queue can accept a fresh retry.
Interactive terminal input is connected: Tab completes commands and the files
available right now plus identifiers read only from currently selected,
non-ignored source. Candidates are refreshed on each Tab press;
`--input-history-file` also makes earlier input recallable,
Alt-Enter continues a message across lines, Ctrl-X Ctrl-E edits the draft in
`$EDITOR`, and `/run --interactive` hands the terminal to one approved command
through the optional `node-pty` package. `--vim` is refused rather than ignored;
Vi modal editing is not implemented. Architect and context are private
application workflows, not public modes; prompt-cache keepalive is
production-wired as an explicit bounded opt-in. Capable models repeat
assistant-prefill continuation up to three times without duplicating prior
output. `/attach` adds bounded, approved image/PDF context for capable models;
attached bytes are request-only and `/drop` removes them.
`--watch-files` shares the terminal session, and `--web` starts the local
authenticated HTTP/SSE API—not a browser GUI. `/web <url>` adds one
user-typed page to the chat as bounded, labeled text. Web session expiry,
quotas, bounded SSE replay/backpressure, reclamation, and structured errors are
enforced. Worktree mutations are serialized in-process, not across separate
Patch processes. Deterministic loopback tests exercise principal/session event
isolation, HTTP disconnect cancellation, SSE overflow/replay, concrete
post-write recovery, and simultaneous terminal/watch/web mutations. See the unchecked items in
[`docs/remaining-integration-tasks.md`](docs/remaining-integration-tasks.md) for
the authoritative remaining scope.

Implemented foundations include strict TypeScript validation, deterministic
fake-provider tests, [safe filesystem behavior](docs/filesystem-safety.md),
staged [configuration bootstrap](docs/configuration-bootstrap.md), a packaged
[model catalog](docs/model-catalog.md), real Git adapters, and a packaged
eleven-language [repository-map engine](docs/repository-maps.md) whose
extraction is verified for every shipped language from the packed tarball. An
installed copy carries `docs/`, so the linked policies are readable offline.
There is no published package or stable interface.

Configuration for histories, multiline input, notifications, watch mode, and
the local web interface follows the same staged YAML, environment/dotenv, and
CLI precedence as model, Git, file, edit, and check controls. Explicit `--no-*`
forms disable configured interface booleans, and repository-root correction
re-resolves all of them without retaining provisional dotenv values.

Shutdown aborts and drains active model streams and subprocesses, closes
providers created by model switches, awaits watcher and web session work, and
finishes each history append without retaining file descriptors. Startup
failures use the same ownership path and do not leave a constructed provider.

Each editing attempt uses one immutable provider-visible snapshot and selection
context through parsing, dry-run resolution, authorization, writes, configured
checks/reflection, commits, and final history/result accounting. A reflected
attempt captures fresh disk context before its next provider request.

The [ancillary feature scope](PORTING_PLAN.md#ancillary-feature-dispositions--p2-item-7)
includes offline `/help`, which now lists commands and performs bounded search
over installed Patch documentation without provider or network access, and
`/settings`, which displays only allowlisted effective/current values without
raw configuration or credentials. `/report [title]` prints a bounded local issue
draft containing only allowlisted Patch, Node.js, OS, architecture, and Git
versions. The optional title is visibly identified as user-supplied; no paths,
chat, source, environment, diagnostics, browser, upload, provider, or network are
involved. All three ancillary commands are exercised through the installed
packed executable; they share the session queue and cancellation behavior and
do not bypass file-write or process approvals.
Browser GUI and CLI voice UX are deferred. Built-in analytics, automatic
provider/model onboarding and OAuth, and update checks/release-note prompts are
non-goals: configuration stays explicit, updates stay user-managed, and release
notes stay in the changelog. Existing `patch --help` is unaffected.

See the [porting plan](PORTING_PLAN.md) for implementation progress and the
[changelog](CHANGELOG.md) for notable changes. Pinned upstream behavior is
recorded using the documented
[compatibility-fixture workflow](docs/compatibility-fixtures.md).
Library adapters include security-bounded [URL fetching](docs/url-fetching.md),
[AI comment watch mode](docs/watch-mode.md), and an authenticated,
session-isolated [local HTTP/SSE interface](docs/web-interface.md). Watch and web
startup use only built-in Node.js adapters; no browser/native package is installed.
Authenticated HTTP partial-turn failures expose bounded changed paths, validated
commit metadata, and command outcomes without internal errors or command output.
Bounded [voice recording and transcription](docs/voice-input.md)
is available through an optional package subpath and can submit to an explicit
application session without native default dependencies.

Read [AGENTS.md](AGENTS.md) for repository guidance, including the requirement to
create or update relevant documentation after every task or code change.

## Try it from source

Requires **Node.js 22+**, **npm**, and **Git**.

```sh
npm ci
npm run check
npm start -- --help
```

The executable accepts `--message`, `--message-file`, or interactive line input.
A model is mandatory even when a provider credential is present; select it with
`--model`, `PATCH_MODEL`, or `.patch.conf.yml`. Provider credentials use
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `DEEPSEEK_API_KEY`. Default startup
requires an existing Git worktree; pass `--no-git` explicitly outside one.
Editable files can be positional or repeated `--file` values; use
`--read-only` for contained context that must not be edited. A directory or a
glob selects the files it covers, contained by the repository boundary, with
symbolic links skipped, ignored files dropped, and the selection bounded; a
named path that does not exist yet stays selectable. An exact existing name is
checked before glob interpretation, so glob metacharacters in a filename remain
literal. External read-only files are not supported.
Use `/attach <path...>` to add up to four approved, contained images or PDFs as
read-only model context. Attachments are limited to 5 MiB each and 10 MiB total,
must match an allowlisted extension and file signature, and are available only
when the selected model declares the matching capability. `/drop` removes them;
their encoded bytes are never copied into chat history or diagnostics.
The currently constructed formats are `ask`, `whole`, `diff`, `diff-fenced`,
`udiff`, and `patch`. Advanced schema values are rejected rather than silently
accepted. This same six-value set drives configuration, model settings,
`/chat-mode` parsing, and terminal completion; helper-only names cannot reach
provider construction. Ordinary `diff` places each filename before its edit
fence;
`diff-fenced` places it inside, immediately after the opening fence and
language, using the fence selected from current file content. See the
[provider documentation](docs/providers.md) and
[input modes](docs/terminal.md#input-modes).
Fence selection repeats after `/add`, `/drop`, edits, and reflected attempts so
the prompt, file context, and parser cannot retain a stale delimiter.
Unified-diff input honors standard `\ No newline at end of file` markers,
including transitions that add or remove the final newline.
Rich terminal contracts and history privacy guidance are documented in
[rich terminal behavior](docs/terminal.md).

Use `patch --watch-files --model 4o file.ts` to process changed `AI!`/`AI?`
comments while terminal input stays open. Git and `.aiderignore` rules apply
unless `--no-git` is selected. `AI?` turns cannot apply edits or run commands;
`AI!` preserves the normal selected-file authorization boundary. EOF, `/exit`,
Ctrl-C, or SIGTERM stops watching and closes the application.

Use `patch --web --web-token-file /path/outside/repo/patch-token --model 4o`
for the experimental local API. Generate a random token and protect its file as
described in [web setup](docs/web-interface.md). The server prints its loopback
address, never the token; `--web-port` optionally selects a port. Stop it with
Ctrl-C or SIGTERM. Web and watch flags are explicit CLI-only startup choices,
cannot be combined with each other or one-shot input, and use the same staged
model/file configuration as terminal startup. This API is for trusted local
clients, not public or multi-tenant hosting.

The internal editor role is production-wired for architect handoff: it uses the
configured editor model/parser with editor-only prompts, no repository map, no
shell commands, and fresh history. `ApplicationSession.runArchitect` now obtains
a read-only proposal, requires an explicit acceptance callback, then performs
that handoff and reconciles cost, commit, selected paths, and final architect
history. `ApplicationSession.selectContext` runs the private context analyst to
bounded convergence, force-refreshing an expanded repository map with original
identifier hints on every pass. A stable complete set replaces editable files
only after all newly selected paths are approved; cancellation, denial, or
non-convergence leaves the parent selection unchanged.
Assistant-prefill continuation is reached inside production `CoderSession` for
capable models but is not wire-compatible for all advertised routes.
`help`, `udiff-simple`, `architect`, `context`, and `editor-*` are therefore not
edit-format schema values. The local `/help` command is separate; architect and
context use private orchestration identities only through application methods.

## Technology direction and references

The implementation uses TypeScript with Node.js and npm. Bun is an option
to evaluate later, not a current runtime or tooling requirement.
See the [Aider-to-Patch porting plan](PORTING_PLAN.md) for the pinned upstream
baseline, target architecture, implementation phases, and verification criteria.

Directly adapted files and resources are required to identify their Aider source
revision, modification, and license. The machine-readable
[direct-derivation ledger](docs/direct-derivations.json) records that evidence
for every identified direct port, and `npm run provenance:check` detects ledger
or per-file attribution drift. Generated compatibility fixtures use their
separate pinned blob-hash boundary. Reference checkouts remain outside this
repository.

## Community

Join the [Patch Discord community](https://discord.gg/sk9Q28VnYG).

## License

Licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for upstream attribution.
Patch is not an official Aider release and does not imply upstream endorsement.

## Brand assets

- [Patch wordmark](assets/logo.svg)
- [Patch icon](assets/logo-icon.svg)

Both logos are SVGs with mint lettering on a charcoal background.
