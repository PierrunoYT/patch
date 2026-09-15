# Aider source inventory — 2026-09-15

## Reproducible boundary

This inventory supports the [2026-09-15 parity audit](aider-parity-audit-2026-09-15.md).
It compares Patch `1bf2ca6adbc3f4774612590f3f7c59c636a4a6e9` with
canonical aider `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`.
Both worktrees were clean before review. The aider checkout remained outside
this repository at `../aider-upstream`.

The product-source manifest was generated from the pinned Git tree, not from
imports or Patch attribution markers:

```sh
git -C ../aider-upstream ls-tree -r --name-only 5dc9490b -- aider
```

It contains 80 Python product modules: 41 directly under `aider/`, 38 under
`aider/coders/`, and `aider/resources/__init__.py`. It also contains two model
data files and 58 Tree-sitter query files. Every one is classified below.
The 36 upstream `test_*.py` modules were reviewed as behavioral evidence by
subsystem; they are tests of the listed product modules, not additional runtime
features to port. Packaging, workflows, and optional product families are
classified in the dated audit.

Generated caches, build outputs, benchmark results, and `aider/website/**` are
excluded. The website is historical/product documentation and media rather than
runtime source; user-visible capabilities described there were still checked
against `aider/args.py`, `aider/commands.py`, and the owning product module.

Status meanings:

- **implemented** — the behavior used by Patch's documented scope is wired to a
  production path; this does not imply byte-identical implementation.
- **partial** — Patch implements a useful subset or different production
  contract; the live backlog records material gaps and defects.
- **unported** — no Patch production equivalent exists.
- **deferred** — wanted product work exists but is not scheduled.
- **non-goal** — intentionally absent unless the product decision changes.
- **excluded** — the pinned aider file is not registered in aider's active coder
  inventory and is not a parity target.

## Top-level and resource Python modules

| Pinned aider file | Status | Patch owner or disposition |
| --- | --- | --- |
| `aider/__init__.py` | partial | `src/index.ts`; Patch exports a deliberately smaller Node API. |
| `aider/__main__.py` | implemented | `src/cli.ts` and `src/program.ts`. |
| `aider/analytics.py` | non-goal | No analytics or telemetry path. |
| `aider/args.py` | partial | `src/program.ts` and `src/config/bootstrap.ts`; many aider controls remain unported. |
| `aider/args_formatter.py` | unported | Commander supplies Patch's smaller help surface; aider's grouped formatter is absent. |
| `aider/commands.py` | partial | `src/commands/**` and concrete application dispatch; Patch has 20 named commands and omits aider aliases and breadth. |
| `aider/copypaste.py` | partial | `src/io/integrations.ts`; text-only and currently lacks process/output bounds. |
| `aider/deprecated.py` | non-goal | No legacy aider-option compatibility layer. |
| `aider/diffs.py` | partial | `src/io/render.ts` colors supplied diffs but does not compute preview hunks. |
| `aider/dump.py` | unported | No debug object-dump command. |
| `aider/editor.py` | partial | `src/io/editor.ts`; temporary-file cleanup is wired, but Windows command tokenization is defective. |
| `aider/exceptions.py` | partial | Typed errors are distributed across Patch subsystem boundaries rather than mirroring LiteLLM exceptions. |
| `aider/format_settings.py` | partial | `src/commands/settings.ts`; intentionally uses a nine-field secret-safe allowlist. |
| `aider/gui.py` | deferred | The authenticated HTTP/SSE API is not a browser GUI. |
| `aider/help.py` | partial | `src/commands/help.ts`; intentionally bounded local literal search rather than model-backed semantic help. |
| `aider/help_pats.py` | unported | Semantic-help pattern corpus is not used by Patch's local help. |
| `aider/history.py` | implemented | `src/core/chat-summary.ts`; bounded input and weak-to-main fallback are Patch hardening. |
| `aider/io.py` | partial | `src/input.ts` and `src/io/**`; rich rendering, broad controls, and exact input semantics remain incomplete. |
| `aider/linter.py` | partial | `src/process/configured-checks.ts`; explicit configured commands only. |
| `aider/llm.py` | partial | `src/providers/factory.ts`; three provider routes rather than LiteLLM breadth. |
| `aider/main.py` | partial | `src/program.ts` and `src/core/concrete-application-service.ts`; Patch has a deliberately narrower startup/mode surface. |
| `aider/mdstream.py` | partial | `src/io/render.ts`; lightweight line renderer, with a known variable-fence defect. |
| `aider/models.py` | partial | `src/models/**`; narrow packaged catalog and controls. |
| `aider/onboarding.py` | non-goal | No automatic account probing, OAuth, or credential persistence. |
| `aider/openrouter.py` | unported / non-goal | OpenRouter is unsupported; implicit startup metadata fetch/cache is intentionally absent. |
| `aider/prompts.py` | partial | `src/resources/prompts.ts` and strategy prompts; English-only, shorter Patch templates. |
| `aider/reasoning_tags.py` | partial | `src/core/reasoning.ts`; final cleanup works, but close-only streamed text cannot be retracted from display. |
| `aider/repo.py` | partial | `src/repository/git.ts`; supported Git workflow plus stronger literal-path and undo rules. |
| `aider/repomap.py` | partial | `src/context/**`; eleven languages and scoped ranking/rendering evidence. |
| `aider/report.py` | partial | `src/commands/report.ts`; intentionally local, bounded, reviewable, and upload-free. |
| `aider/run_cmd.py` | partial | `src/process/**`; explicit approval and bounds, narrower PTY behavior. |
| `aider/scrape.py` | partial | `src/interfaces/url-fetcher.ts`; explicit URL only, DNS-pinned, bounded, no production browser rendering. |
| `aider/sendchat.py` | partial | Provider adapters and message validation implement supported routes, not LiteLLM-wide repair behavior. |
| `aider/special.py` | implemented | `src/context/important-files.ts`. |
| `aider/urls.py` | partial | `/web` fetches one explicitly typed URL; automatic URL detection is absent. |
| `aider/utils.py` | partial | Equivalent utility behavior is distributed; no claim of utility-by-utility parity. |
| `aider/versioncheck.py` | non-goal | Updates and release notes remain npm/user managed. |
| `aider/voice.py` | deferred | Optional `@pierrunoyt/patch/voice` helper only; no CLI/device UX. |
| `aider/waiting.py` | unported | No aider-style waiting spinner/progress renderer. |
| `aider/watch.py` | partial | `src/interfaces/watch-mode.ts`; different marker/authorization policy and a known ancestor-swap read gap. |
| `aider/watch_prompts.py` | partial | Patch emits shorter line-oriented watch context and retains its authorization boundary. |
| `aider/resources/__init__.py` | implemented | Build/package scripts copy explicit runtime resources without Python package loading. |

## Coder modules

| Pinned aider file | Status | Patch owner or disposition |
| --- | --- | --- |
| `aider/coders/__init__.py` | partial | `src/edits/registry.ts`; six public formats plus private architect/context identities. |
| `aider/coders/architect_coder.py` | partial | Private `runArchitect`; not an executable mode. |
| `aider/coders/architect_prompts.py` | partial | Short private architect prompt in `src/resources/strategy-prompts.ts`. |
| `aider/coders/ask_coder.py` | implemented | `src/edits/ask.ts`. |
| `aider/coders/ask_prompts.py` | partial | Protocol-equivalent, shorter English prompt. |
| `aider/coders/base_coder.py` | partial | `src/core/coder-session.ts` and concrete application lifecycle; no full coder-state or option parity. |
| `aider/coders/base_prompts.py` | partial | `src/resources/prompts.ts` and strategy prompts. |
| `aider/coders/chat_chunks.py` | implemented | `src/core/chat-chunks.ts` for Patch message types and cache boundaries. |
| `aider/coders/context_coder.py` | partial | Private bounded `selectContext`; not an executable mode. |
| `aider/coders/context_prompts.py` | partial | Private context prompt and retry reminder. |
| `aider/coders/editblock_coder.py` | implemented | `src/edits/search-replace.ts` with ambiguity rejection hardening. |
| `aider/coders/editblock_fenced_coder.py` | implemented | Distinct `diff-fenced` prompt/layout over the same parser. |
| `aider/coders/editblock_fenced_prompts.py` | partial | Shorter Patch-authored equivalent. |
| `aider/coders/editblock_func_coder.py` | excluded | Not registered in pinned aider `__all__`. |
| `aider/coders/editblock_func_prompts.py` | excluded | Companion to an unregistered coder. |
| `aider/coders/editblock_prompts.py` | partial | Shorter Patch-authored equivalent. |
| `aider/coders/editor_diff_fenced_coder.py` | implemented | Private fresh editor using `diff-fenced`. |
| `aider/coders/editor_diff_fenced_prompts.py` | partial | Editor-only no-shell/no-map prompt subset. |
| `aider/coders/editor_editblock_coder.py` | implemented | Private fresh editor using `diff`. |
| `aider/coders/editor_editblock_prompts.py` | partial | Editor-only no-shell/no-map prompt subset. |
| `aider/coders/editor_whole_coder.py` | implemented | Private fresh editor using `whole`. |
| `aider/coders/editor_whole_prompts.py` | partial | Editor-only no-shell/no-map prompt subset. |
| `aider/coders/help_coder.py` | unported | Replaced by local bounded `/help`; no model-backed help coder. |
| `aider/coders/help_prompts.py` | unported | Not used by Patch's local help. |
| `aider/coders/patch_coder.py` | partial | `src/edits/patch.ts`; scoped typed actions with stronger conflict rejection. |
| `aider/coders/patch_prompts.py` | partial | Shorter Patch protocol prompt. |
| `aider/coders/search_replace.py` | implemented | Exact/indentation/elision matching with ambiguity rejection. |
| `aider/coders/shell.py` | implemented | Supported edit strategies parse suggestions; execution remains explicitly approved and bounded. |
| `aider/coders/single_wholefile_func_coder.py` | excluded | Not registered in pinned aider `__all__`. |
| `aider/coders/single_wholefile_func_prompts.py` | excluded | Companion to an unregistered coder. |
| `aider/coders/udiff_coder.py` | partial | Bounded recovery exists, but two P0 parser/application defects remain. |
| `aider/coders/udiff_prompts.py` | partial | Shorter Patch protocol prompt. |
| `aider/coders/udiff_simple.py` | unported | Registered upstream format not exposed by Patch. |
| `aider/coders/udiff_simple_prompts.py` | unported | Companion prompt is absent. |
| `aider/coders/wholefile_coder.py` | implemented | `src/edits/whole-file.ts` for Patch's supported contract. |
| `aider/coders/wholefile_func_coder.py` | excluded | Not registered in pinned aider `__all__`. |
| `aider/coders/wholefile_func_prompts.py` | excluded | Companion to an unregistered coder. |
| `aider/coders/wholefile_prompts.py` | partial | Shorter Patch-authored equivalent. |

## Runtime data and Tree-sitter queries

| Pinned aider files | Status | Patch disposition |
| --- | --- | --- |
| `aider/resources/model-metadata.json` | partial | `src/resources/model-metadata.json5`; advertised DeepSeek limits currently disagree with the pinned file. |
| `aider/resources/model-settings.yml` | partial | `src/resources/model-settings.yml`; `gpt-4o-mini` and DeepSeek Reasoner defaults currently disagree with pinned settings. |
| `tree-sitter-language-pack/{bash,cpp,go,java,javascript,python,ruby,rust}-tags.scm` | implemented | Directly adapted packaged queries with pinned tag samples. |
| `tree-sitter-languages/typescript-tags.scm` | implemented | Packaged TypeScript query plus TSX adaptation. |
| `tree-sitter-language-pack/c-tags.scm` | partial | C is supported through Patch's C/C++ extraction path, not this exact query. |
| `tree-sitter-language-pack/csharp-tags.scm` and `tree-sitter-languages/c_sharp-tags.scm` | partial | C# is supported with an independently sourced MIT query, not either exact aider query. |

The remaining 46 pinned queries are unported:

```text
aider/queries/tree-sitter-language-pack/arduino-tags.scm
aider/queries/tree-sitter-language-pack/chatito-tags.scm
aider/queries/tree-sitter-language-pack/clojure-tags.scm
aider/queries/tree-sitter-language-pack/commonlisp-tags.scm
aider/queries/tree-sitter-language-pack/d-tags.scm
aider/queries/tree-sitter-language-pack/dart-tags.scm
aider/queries/tree-sitter-language-pack/elisp-tags.scm
aider/queries/tree-sitter-language-pack/elixir-tags.scm
aider/queries/tree-sitter-language-pack/elm-tags.scm
aider/queries/tree-sitter-language-pack/gleam-tags.scm
aider/queries/tree-sitter-language-pack/lua-tags.scm
aider/queries/tree-sitter-language-pack/matlab-tags.scm
aider/queries/tree-sitter-language-pack/ocaml-tags.scm
aider/queries/tree-sitter-language-pack/ocaml_interface-tags.scm
aider/queries/tree-sitter-language-pack/pony-tags.scm
aider/queries/tree-sitter-language-pack/properties-tags.scm
aider/queries/tree-sitter-language-pack/r-tags.scm
aider/queries/tree-sitter-language-pack/racket-tags.scm
aider/queries/tree-sitter-language-pack/solidity-tags.scm
aider/queries/tree-sitter-language-pack/swift-tags.scm
aider/queries/tree-sitter-language-pack/udev-tags.scm
aider/queries/tree-sitter-languages/bash-tags.scm
aider/queries/tree-sitter-languages/c-tags.scm
aider/queries/tree-sitter-languages/cpp-tags.scm
aider/queries/tree-sitter-languages/dart-tags.scm
aider/queries/tree-sitter-languages/elisp-tags.scm
aider/queries/tree-sitter-languages/elixir-tags.scm
aider/queries/tree-sitter-languages/elm-tags.scm
aider/queries/tree-sitter-languages/fortran-tags.scm
aider/queries/tree-sitter-languages/go-tags.scm
aider/queries/tree-sitter-languages/haskell-tags.scm
aider/queries/tree-sitter-languages/hcl-tags.scm
aider/queries/tree-sitter-languages/java-tags.scm
aider/queries/tree-sitter-languages/javascript-tags.scm
aider/queries/tree-sitter-languages/julia-tags.scm
aider/queries/tree-sitter-languages/kotlin-tags.scm
aider/queries/tree-sitter-languages/matlab-tags.scm
aider/queries/tree-sitter-languages/ocaml-tags.scm
aider/queries/tree-sitter-languages/ocaml_interface-tags.scm
aider/queries/tree-sitter-languages/php-tags.scm
aider/queries/tree-sitter-languages/python-tags.scm
aider/queries/tree-sitter-languages/ql-tags.scm
aider/queries/tree-sitter-languages/ruby-tags.scm
aider/queries/tree-sitter-languages/rust-tags.scm
aider/queries/tree-sitter-languages/scala-tags.scm
aider/queries/tree-sitter-languages/zig-tags.scm
```

The alternate-directory copies for languages Patch already supports are still
listed as unported because Patch selected and attributed the other pinned query;
language support is not evidence that both upstream files were ported.

## Test, package, and workflow evidence

The pinned tree has 36 executable Python test modules: 32 under `tests/basic/`,
one browser test, one help test, and two scrape tests. The audit compared their
behavioral families with Patch's Vitest, package-smoke, and workflow evidence;
it did not mechanically translate tests or count a similarly named test as
production parity. The five other Python files under `tests/` are package
initializers or fixtures.

`pyproject.toml`, `pytest.ini`, nine upstream workflows, Python/Docker release
packaging, and the website build are not runtime modules. Patch replaces them
with its Node.js 22/npm package, `package.json`, TypeScript/ESLint/Prettier/Vitest
configuration, package smoke, and four documented CI job families. Python and
Docker distribution parity is a non-goal; cross-platform package and protected
provider evidence remains revision-specific.

## Completeness limits

This inventory makes upstream-file coverage reproducible. It does not prove
semantic equivalence inside a file, detect every behavioral interaction, or
make the 63-entry direct-derivation ledger complete by construction. The ledger
answers “which Patch files identify themselves as direct adaptations”; this
inventory separately answers “what happened to every pinned aider product
file.” Both must be maintained when the pinned revision changes.
