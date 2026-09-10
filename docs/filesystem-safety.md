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

Atomic replacement is not a metadata-preserving transaction. It creates a new
inode, retains only ordinary mode bits, can sever hardlinks, and does not promise
ACL, ownership, xattr, file-flag, alternate-stream, directory-fsync, or crash
durability preservation. Containment and snapshot checks operate on path strings
and have check-to-use windows under concurrent directory/file replacement.
Deletion has the same ancestor-swap concern. These are unresolved policies, not
claims of race-free containment.

The encoding and newline adapter is stricter than Aider and supports only the
documented codecs. Explicit LF/CRLF conversion is currently a library option;
the executable exposes encoding but not line-ending policy. Static containment,
full-batch staging, and sibling temporary replacement remain intentional safety
improvements over Aider's direct truncating writes, subject to the metadata and
concurrency limits above.

`applyAuthorizedEdits` is the final write workflow. It presents the complete
staged preview before asking for per-path authorization, requires approval for
every new or out-of-chat file, checkpoints dirty existing files through an
injected repository callback, commits the already validated transaction, and
returns the exact changed paths and checkpoint. Authorization failure occurs
before checkpoints or writes.

Snapshots are revalidated after authorization and before the dirty checkpoint,
then again before the first write. Cancellation is checked at these boundaries
and between replacements. A failed or cancelled multi-file commit does not
roll back completed replacements; later files remain untouched. See
[turn recovery](turn-lifecycle.md) for exact Git, history, and queue limits and
the real-repository failure tests.
