# Filesystem safety

Patch treats paths from model output, configuration, and user input as
untrusted. `SafePathResolver` establishes a canonical selected root before any
filesystem adapter uses those paths.

## Resolution contract

Create one resolver for an existing directory with
`SafePathResolver.create(root)`. The exposed `root` is the result of the
platform's native `realpath`, even when the selected root was itself a symlink.

`resolve(target)` accepts relative paths and absolute paths, but returns a
canonical absolute path only when the result remains inside that root. It:

1. resolves relative input from the canonical root;
2. canonicalizes an existing target through all symlinks;
3. for a target that does not exist, canonicalizes its nearest existing
   ancestor before appending the missing path components; and
4. compares path components with `path.relative`, rather than using an unsafe
   string-prefix check.

Traversal, absolute paths outside the root, and existing or missing targets
below an escaping symlink throw `PathOutsideRootError`. Dangling symlinks are
rejected instead of being treated as ordinary missing files. Unicode and spaces
remain valid path content.

## Write boundary

Resolution is intentionally separate from file editing. Every filesystem write
adapter must call `resolve()` immediately before opening or replacing a target;
a path checked earlier in a workflow is not authorization to write later.
`FileSystemAdapter` retains this final containment check when it performs an
atomic replacement.

## Text files and replacement

`FileSystemAdapter` reads and writes text through the resolver. It supports
`utf-8` (the default), `utf-16le`, and `latin1`, validates malformed UTF input,
and refuses writes that cannot be represented by the selected encoding. UTF-8
and UTF-16LE byte-order marks are retained when replacing an existing file.

Reads normalize CRLF and legacy CR separators to LF for edit matching and report
the source line ending separately. Writes preserve the first line-ending style
found in an existing file by default; callers may explicitly select LF or CRLF.
Files without a newline and new files use the platform line ending unless a
style is selected.

A dry run performs path, decoding, encoding, and line-ending resolution and
returns the prospective byte count without creating a file or directory. A
real write creates a unique sibling temporary file, flushes and closes it, then
renames it over the destination. Existing permission bits are retained, and a
failed operation removes the temporary file. The destination is resolved again
before rename, and a changed or escaping path aborts the replacement.

These rules preserve the configurable encoding, newline conversion, and dry-run
behavior in aider's
[`InputOutput`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L323-L333),
while intentionally replacing aider's direct truncating
[`write_text`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L478-L503)
with an atomic write. Path handling is also stricter than aider's general
[`safe_abs_path`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/utils.py#L96-L103),
which canonicalizes a path but does not enforce repository containment. The
additional boundary implements Patch's documented requirement to prevent model
edits from escaping the selected repository through `..` or symlinks.
