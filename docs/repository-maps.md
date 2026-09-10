# Repository maps

Repository-map support is a scoped TypeScript/ESM implementation of pinned
`aider/repomap.py`, not full behavioral parity. Patch does not invoke Python or
Aider at runtime.

Runtime tag queries live under `src/resources/repomap/queries`. Grammar WASM
files come from the exact `@vscode/tree-sitter-wasm` version recorded in
`package-lock.json`; both that package and `web-tree-sitter` are ordinary npm
runtime dependencies. The build copies queries to `dist/resources/repomap`, and
all resources are resolved relative to `import.meta.url`, never the process
working directory. Branding-only `assets/` remains unchanged.

The initial grammar set is JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`),
TypeScript (`.ts`, `.tsx`), Python (`.py`, `.pyi`), Go (`.go`), and Rust
(`.rs`). TypeScript and TSX use their corresponding grammars. A new language
requires a pinned grammar, an attributed tag query, compatibility fixtures,
extraction tests, and packed-package smoke coverage.

Production filters selected and raw tracked paths through ordinary Git and root
`.aiderignore` rules before snapshots, mention matching, map extraction, or
provider requests. The check is repeated for each turn and ignored model edit
targets fail before their content is read. Missing, deleted, unreadable, or
parser-failed visible tracked files can still abort a complete turn instead of
being skipped with a bounded warning.

`TagExtractor` resolves every requested file through `SafePathResolver`, reads
UTF-8 source without invoking a shell, parses it with `web-tree-sitter`, and
returns zero-based definition/reference tags. Unsupported extensions and empty
files return no tags. Symlink escapes and traversal outside the selected root
are rejected before reading.

Ranking implements the principal Aider weighted graph/PageRank formula with
deterministic ordering. Production mention detection, per-file lexical-reference
fallback, important-root-file priority, and rank-only bare-file ordering remain
incomplete.

`TreeContextRenderer` provides syntax-parent headers and `⋮` elisions, but it is
a narrow approximation rather than a generic `grep_ast.TreeContext` equivalent.
The model budget is currently a fixed 1,024 tokens with a character-count
estimate; Aider's model-aware sizing, no-file multiplier, and user controls are
not composed. Strict prefix fitting is an intentional Patch difference.

`RepositoryMap` composes extraction, ranking, and rendering. Its JSON tag cache
uses mtime, size, and SHA-256 and falls back to memory after cache-file failures.
Per-file read/parser failures are not isolated. The cache schema also lacks a
query/grammar/extractor fingerprint, so resource upgrades can reuse old tags.

The helper exposes `always`, `files`, `manual`, and `auto` refresh modes, but the
production CLI exposes no refresh controls, does not couple prompt caching to
stable `files` refresh, freezes tracked inventory at service startup, and does
not perform Aider's broader fallback map requests.

The pinned exporter compares raw tags, definition order, and normalized
rendering for one two-file Python scenario. It removes line-`-1` lexical
fallback tags and deduplicates before storage. It does not prove numeric ranks,
personalization, important files, other languages, caches, token fitting,
generic tree context, or the production provider request.

The package smoke installs the tarball and exercises JavaScript, TypeScript,
Python, Go, and Rust extraction. TSX resources are shipped but are not exercised
after clean install, and the smoke does not render a complete installed
`RepositoryMap`.
