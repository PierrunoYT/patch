# Upstream compatibility fixtures

Patch records deterministic outputs from the pinned aider checkout before
porting behavior. These fixtures are development oracles, not runtime data, and
are excluded from the npm package.

There are two intentionally distinct evidence sources. The generated
`aider-5dc9490b.json` below is exported by pinned upstream code. The manually
authored `edit-format-goldens.json` is independent of Patch output and records a
pinned source path/classification for each constructed format; its malformed,
ambiguity, failure, and cancellation cases are Patch hardening tests, not
upstream-export compatibility.

The exporter currently captures:

- config file, environment, and CLI precedence;
- message chunk ordering and prompt-cache boundaries;
- common prompt resources and ordered fence-selection behavior;
- the registered edit-format list;
- SEARCH/REPLACE parsing, errors, exact edits, indentation handling, and
  `...` elision;
- unified-diff parsing for a response carrying two files, including the hunks
  and the paths upstream targets;
- staged and unstaged Git diff behavior;
- a small Python repository map, including normalized tags, definition rank
  order, and rendered context;
- one tagged sample per language Patch ships a grammar for — JavaScript,
  TypeScript, TSX, Python, Go, Rust, Bash, C/C++, C#, Java, and Ruby — each
  stored with the source it was tagged from; and
- the important-root-file selection for a mixed candidate list.

Patch's tree-sitter WebAssembly grammars and its copies of upstream's tag
queries reproduce aider's tags exactly for the committed sample in each of the
eleven shipped language entries, not for all possible programs. The unified-diff
golden records one deliberate divergence: `process_fenced_block` strips `a/`/`b/`
prefixes only from a block's leading header pair, so upstream targets `b/…` for a
mid-block file transition, while Patch strips the prefix whenever both headers
carry one. The test asserts both, so neither side can change unnoticed.

## Regenerating fixtures

The checkout specified by `AIDER_CHECKOUT` must match `upstream.json` exactly.
It needs an isolated editable installation so the exporter runs aider's own
code:

```sh
cd ../aider-upstream
uv venv .venv
uv pip install --python .venv/bin/python -e .
cd /path/to/patch
npm run fixtures:upstream
```

The default checkout is the sibling directory `../aider-upstream`. Set
`AIDER_CHECKOUT` and, when needed, `AIDER_PYTHON` to use other locations.

## What the exporter refuses

A fixture is only evidence if it came from the pinned source, so the exporter
checks four things before running aider's code:

- the checkout's `origin` matches `upstream.json`;
- `HEAD` is the pinned commit;
- the working tree is clean. A dirty checkout still reports the pinned commit
  and remote, so uncommitted work would otherwise be exported as pinned upstream
  behavior; and
- every file listed in `upstream.json`'s `fixtureSources` matches its recorded
  blob hash both at the pinned commit and as it sits on disk. `status` can be
  silenced per file with `assume-unchanged` or `skip-worktree`, so a clean report
  is not enough on its own.

The manifest now covers all twelve directly imported modules, including
`aider/coders/__init__.py`, `aider/coders/udiff_coder.py`, and `aider/special.py`,
closing the direct-import gap in the
[2026-09-11 audit](aider-parity-audit-2026-09-11.md). Their hashes were checked
against the pinned upstream checkout. This is not a transitive-dependency or
resource-file integrity guarantee.

Adding a scenario that imports another aider module requires adding that module
to `fixtureSources`. `tests/upstream-fixtures.test.ts` reads the driver's actual
imports and requires a manifest entry for each module. Keep upstream imports
explicit and single-line: `import aider.module as alias` for modules/packages,
or `from aider.module import Symbol` for symbols in a `.py` module. Package
submodule from-imports and compound imports are not supported by this check;
dynamic imports are outside its scope. CI needs neither Python nor an upstream
checkout. Regression cases add unlisted imports and remove each formerly missing
entry. A disposable Git repository also proves that the real exporter rejects
changes hidden with either `assume-unchanged` or `skip-worktree` before Python
starts, while clean source reaches the Python-environment check.

Regeneration is deliberately separate from `npm run check`: ordinary builds
and CI do not require Python or the aider checkout. Tests only consume the
committed JSON output.

Review fixture diffs before committing them. A changed fixture means either the
pinned upstream revision changed, the exporter scenario changed, or execution
is nondeterministic; determine which one before updating the TypeScript port.

## Direct-import coverage verification — 2026-09-11

On Linux, the coverage follow-up passed `npm run check` (482 tests passed,
four gated tests skipped, plus formatting, lint, typecheck, build, and packed
installation/lifecycle smoke tests) and `npm start -- --help`.
`npm run fixtures:upstream` ran against the clean pinned sibling checkout and
regenerated `aider-5dc9490b.json` byte-identically: SHA-256
`b60061ef27c9c3df820206c777308a2af103b2fc21f325a34534aad38b4c0ea3`.
The dated audit remains unchanged as a historical snapshot. No new Windows,
macOS, or live-provider evidence is claimed by this follow-up.
