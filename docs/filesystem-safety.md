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
a path checked earlier in a workflow is not authorization to write later. The
atomic-write task will own replacement and rollback semantics and must retain
this final containment check.

This is stricter than aider's general
[`safe_abs_path`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/utils.py#L96-L103),
which canonicalizes a path but does not enforce repository containment. The
additional boundary implements Patch's documented requirement to prevent model
edits from escaping the selected repository through `..` or symlinks.
