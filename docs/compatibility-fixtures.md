# Upstream compatibility fixtures

Patch records deterministic outputs from the pinned aider checkout before
porting behavior. These fixtures are development oracles, not runtime data, and
are excluded from the npm package.

The exporter currently captures:

- config file, environment, and CLI precedence;
- message chunk ordering and prompt-cache boundaries;
- common prompt resources and ordered fence-selection behavior;
- the registered edit-format list;
- SEARCH/REPLACE parsing, errors, exact edits, indentation handling, and
  `...` elision;
- staged and unstaged Git diff behavior; and
- a small Python repository map, including normalized tags, definition rank
  order, and rendered context.

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
- every file in `upstream.json`'s `fixtureSources` — one entry per module the
  fixture driver imports — matches its recorded blob hash both at the pinned
  commit and as it sits on disk. `status` can be silenced per file with
  `assume-unchanged` or `skip-worktree`, so a clean report is not enough on its
  own.

Adding a scenario that imports another aider module means adding that module to
`fixtureSources`; `tests/upstream-fixtures.test.ts` keeps the list complete and
well-formed in ordinary CI, which has no checkout to inspect.

Regeneration is deliberately separate from `npm run check`: ordinary builds
and CI do not require Python or the aider checkout. Tests only consume the
committed JSON output.

Review fixture diffs before committing them. A changed fixture means either the
pinned upstream revision changed, the exporter scenario changed, or execution
is nondeterministic; determine which one before updating the TypeScript port.
