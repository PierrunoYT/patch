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

`/attach` applies the resolver again immediately before opening media. The
canonical target is opened read-only with no-follow where the platform supports
it, verified as a regular file, bounded before allocation, and read through an
`AbortSignal`. Extension and signature/terminator must agree. The application
keeps only approved relative labels outside the private attachment map; base64
bytes are never placed in session snapshots, completed history, or diagnostics.

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
renames it over the destination. Permission bits and ownership are carried over
only within the platform and privilege limits below; cleanup of a failed
operation attempts to remove the temporary file. The destination is
resolved again before rename, and a changed or escaping path — or a containing
directory that is no longer the one authorized — aborts the replacement.

Atomic replacement creates a new inode. Patch rejects replacement and deletion
when the target is not a regular file or has more than one hard link, including
when another link is outside the selected root. It captures device, inode, mode,
owner, group, link count, size, and modification/change times around reads and
rechecks that identity immediately before rename or unlink. A detectable
replacement, content/metadata change, ownership change, or new hard link aborts
without mutating the selected target.

### What a replacement preserves

| Attribute                                                     | Policy                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode bits                                                     | Passed to temporary-file creation on POSIX, subject to the process umask. Windows does not provide equivalent POSIX mode preservation; this is not a Windows ACL guarantee.                                                                                                                                                                                   |
| Owner and group                                               | Preserved when the process is permitted to set them. A refusal (`EPERM`, `EINVAL`, `ENOSYS`, `ENOTSUP`) leaves the writing process as the owner rather than failing the write; an unprivileged process replacing a file it does not own is the ordinary case. |
| Byte-order mark and line endings                              | Preserved as described above.                                                                                                                                                                                                                                 |
| Inode                                                         | Not preserved: replacement is a rename, by design, so no partial content is ever visible.                                                                                                                                                                     |
| Timestamps                                                    | Not preserved: the content changed, so the new modification time is correct.                                                                                                                                                                                  |
| ACLs, extended attributes, file flags, alternate data streams | Not preserved. Node exposes no portable API to read or copy them, so Patch cannot carry them through a rename and does not claim to.                                                                                                                          |

Preserving the remaining attributes would require writing in place, which is
what pinned Aider does and which admits partially written files. Patch keeps
atomic replacement instead; a repository that depends on per-file ACLs or
extended attributes needs a platform adapter Patch does not yet have.

### Ancestor check-to-use policy

Mutations are authorized against a resolved path and its containing directory.
Node exposes no `openat`/`renameat`, so the directory cannot be pinned by
descriptor for the syscall itself. Instead the containing directory's device and
inode are captured when the mutation is prepared — before the write path builds
its temporary file, and before the delete path even inspects its target — and
rechecked immediately before the rename or unlink: a directory swapped for a
different directory at the same path is detected and refused with
`AncestorChangedDuringWriteError`,
even though the path still resolves. The residual window between that recheck
and the syscall cannot be closed portably, so this is detection, not prevention;
an untrusted local process with write access to an ancestor is still outside
Patch's threat model. A swap detected this way can leave the hidden, uniquely
named temporary file in the directory that was moved away, because cleanup
unlinks by path; it is never renamed over repository content.

Both previously failing Windows tests were test defects rather than production
limits, and both are fixed. Permission retention is asserted against the mode
the file actually carried, because Windows `chmod` only toggles the read-only
bit and never records the requested POSIX mode. The ancestor-swap injection now
swaps the directory once the temporary file is closed instead of while its
handle is open: Windows refuses to rename a directory containing an open file,
so the injection returned `EPERM` instead of reaching the identity check. The
swap still occurs inside the detection window, because the containing directory
is rechecked after the write and before the rename.

Patch also does not promise directory-fsync or crash-durability guarantees.

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
