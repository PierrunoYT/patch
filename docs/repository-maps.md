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

The shipped extraction set covers JavaScript, TypeScript, TSX, Python, Go,
Rust, Bash, C/C++, C#, Java, and Ruby. TypeScript and TSX use distinct grammars;
Patch currently routes `.c` and `.h` through the C++ grammar. The C/C++ golden
uses a `.cpp` sample, so it does not establish separate C-source/header parity.
A new language requires a pinned grammar, an attributed tag query,
compatibility fixtures, extraction tests, and packed-package smoke coverage.

Production filters selected and raw tracked paths through ordinary Git and root
`.aiderignore` rules before snapshots, mention matching, map extraction, or
provider requests. The check is repeated for each turn and ignored model edit
targets fail before their content is read. A missing, deleted, unreadable, or
parser-failed tracked file is skipped rather than aborting the turn; surfacing
the skip to the user as a bounded warning is still missing.

`TagExtractor` resolves every requested file through `SafePathResolver`, reads
UTF-8 source without invoking a shell, parses it with `web-tree-sitter`, and
returns zero-based definition/reference tags. Unsupported extensions and empty
files return no tags. Symlink escapes and traversal outside the selected root
are rejected before reading.

Ranking implements the principal Aider weighted graph/PageRank formula with
deterministic ordering.

A file no bundled grammar covers still contributes: `lexicalReferences` records
its identifiers as references, so a config file, a Markdown document, or a
language without a query still ranks the files that define the symbols it
mentions. They are references only — nothing lexical can distinguish a
definition from a mention — each identifier is reported once at its first line,
one file contributes at most 200, and a file containing a NUL byte is treated as
binary and skipped.

Because the map is truncated to a prefix, order decides what survives.
`filterImportantFiles` ports aider's root-file list — READMEs, licenses,
manifests, lockfiles, CI definitions, and `.github/workflows/*.yml` — and those
files are listed before ranked symbols, with the remaining untagged files after.
Only the repository root counts: a `README.md` beside a source file describes
that directory, not the project. Rank-only bare-file ordering remains
incomplete.

`TreeContextRenderer` ports the pinned repository-map configuration of
`grep_ast.TreeContext` for every shipped grammar: it walks generic syntax scopes,
adds the shortest parent header (capped at ten lines), omits top-of-file parent
scopes, and emits one `⋮` marker per hidden region. Repository maps deliberately
disable child context, margins, last-line context, LOI markers, and LOI padding.
Exact Python and TypeScript fixtures plus the normalized upstream map hold this
behavior level. The model budget is model-aware, ported from
`Model.get_repo_map_tokens`: `repoMapTokens` gives 1,024 tokens by default and
otherwise an eighth of the model's input limit, clamped to 1,024–4,096, so a
larger context window earns a larger map without letting the map crowd out the
conversation. A turn holding
nothing in the chat gets a wider view only when its model has an input limit:
the budget times `mulNoFiles` (8), capped at the context window less 4,096 tokens
of headroom. This follows the upstream helper's default multiplier, not aider's
CLI default of 2. Every advertised bundled model now has an input limit, so its
window determines the base budget. Production fitting uses the selected model's
`tiktoken` encoding for recognized OpenAI models and a labeled four-character
estimate for Anthropic, DeepSeek, and unknown models. No user-facing control
exposes the budget. Strict prefix fitting is an intentional Patch difference.

`RepositoryMap` composes extraction, ranking, and rendering. Its JSON tag cache
uses mtime, size, and SHA-256 and falls back to memory after cache-file failures.
Per-file read and parser failures are isolated: the map is advisory context, so
a path that cannot be read or parsed is dropped from the map and reported by
`skippedPaths` rather than propagating out of `getMap`. That covers rendering as
well as tagging — the map is rendered several times while it is fitted to its
budget, so a file can disappear after it was tagged and before its body is
read. A path that becomes
readable again is removed from that set on the next construction.

The cache file records an extractor fingerprint alongside its entries, and tags
written under a different one are discarded rather than reused. The fingerprint
covers an explicit extractor version, the contents of every bundled `.scm`
query, and each grammar's file size — query text is hashed because editing one
is the common case, while grammars are identified by size so a multi-megabyte
wasm file is not rehashed on every startup.

The helper exposes `always`, `files`, `manual`, and `auto` refresh modes, but the
production CLI exposes no refresh controls and does not couple prompt caching to
stable `files` refresh. The tracked inventory is re-read from Git each turn
rather than frozen at startup, so a file added, removed, or renamed mid-session
reaches both file context and the map; a transient Git failure falls back to the
startup inventory instead of failing the turn. Each production turn first asks
for a map relative to selected files and current filename/identifier hints. An
empty result retries globally with the same hints, then globally without hints,
stopping at the first non-empty result. Every request reuses the already filtered
tracked inventory, so fallback cannot disclose ignored or untracked paths.

The private production context workflow is the one deliberate refresh override.
It creates a dedicated `always` map, multiplies the model-derived base budget by
eight (bounded by model context headroom), and disables a second empty-chat
multiplier. Every convergence pass sets `forceRefresh`, supplies the current
complete provisional file set as chat paths, and preserves mentioned paths and
identifier hints from the original request. This ports `context_coder.py`'s
expanded/always behavior without weakening Patch's filtered tracked inventory,
containment checks, or strict prefix fitting.

The pinned exporter compares raw tags, definition order, and normalized
rendering for one two-file Python scenario. It also captures important-root-file
selection and one source-backed tag sample for every shipped language entry.
These samples do not establish full language, numeric rank, personalization,
cache, token-fitting, generic tree-context, or production-request parity. The
Python map fixture removes line-`-1` lexical fallback tags and deduplicates before
storage, so it does not pin Patch's own lexical fallback, which reports first-line
positions instead. That fallback remains covered by Patch's local tests.

The package smoke installs the tarball and exercises tag extraction for all
eleven shipped language entries, including TSX. This is installed-extractor
coverage, not complete installed-map ranking/rendering parity.
