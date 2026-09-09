# Repository maps

Repository-map support follows aider's pinned `aider/repomap.py` behavior while
using TypeScript, ESM, and `web-tree-sitter`. Patch does not invoke Python or
aider at runtime.

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

`TagExtractor` resolves every requested file through `SafePathResolver`, reads
UTF-8 source without invoking a shell, parses it with `web-tree-sitter`, and
returns zero-based definition/reference tags. Unsupported extensions and empty
files return no tags. Symlink escapes and traversal outside the selected root
are rejected before reading.

Ranking builds aider's weighted reference multigraph and runs local PageRank
with a fixed damping factor, convergence tolerance, and sorted iteration order.
Repeated references use square-root scaling; descriptive, private, widely
defined, and explicitly mentioned identifiers receive aider-compatible
multipliers. Chat-file references are weighted more strongly, while chat-file
definitions are omitted from the result. File and identifier mentions seed the
personalization and dangling-node distribution.

`TreeContextRenderer` adds syntax-parent header lines around selected definition
lines and marks omitted regions with `⋮`, matching the compact shape of
`grep_ast.TreeContext` without a Python dependency. Repository-map rendering
groups selected lines by normalized path, truncates pathological source lines
to 100 characters, omits chat files, and includes bare entries for files with
no tags. Binary search chooses the largest ranked prefix whose injected token
counter does not exceed the configured budget.

`RepositoryMap` composes extraction, ranking, and rendering. Its atomic JSON tag
cache is stored under the selected root by default, validates cached values,
and keys each file by mtime, size, and SHA-256 content so timestamp collisions
cannot return stale tags. Missing, corrupt, or unwritable caches fall back to a
correct in-memory result and are rewritten when possible.

Refresh modes match aider's contracts: `always` rebuilds each call; `files`
caches by chat/other file lists; `manual` retains the last map; and `auto`
caches maps whose previous build exceeded one second, including mentions in its
key. A forced refresh bypasses every rendered-map mode while retaining valid
content-keyed tag entries.
