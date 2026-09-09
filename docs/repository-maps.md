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

The initial grammar set is JavaScript, TypeScript, Python, Go, and Rust. A new
language requires a pinned grammar, an attributed tag query, compatibility
fixtures, extraction tests, and packed-package smoke coverage.

`TagExtractor` resolves every requested file through `SafePathResolver`, reads
UTF-8 source without invoking a shell, parses it with `web-tree-sitter`, and
returns zero-based definition/reference tags. Unsupported extensions and empty
files return no tags. Symlink escapes and traversal outside the selected root
are rejected before reading.
