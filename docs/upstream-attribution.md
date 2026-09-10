# Upstream attribution

Patch ports behavior and selected source from
[`Aider-AI/aider`](https://github.com/Aider-AI/aider) under the Apache License,
Version 2.0. The pinned porting baseline is recorded in `upstream.json`.

Direct ports must include a header in this form, adapted to the file's comment
syntax:

```text
Derived from Aider-AI/aider: <upstream path>
Upstream revision: <full commit SHA>
Modified for Patch's TypeScript/Node.js implementation.
Licensed under the Apache License, Version 2.0.
```

## Current audit status

The rule above is not yet mechanically complete. The pinned parity audit found
directly adapted shipped model/query resources without the explicit license
line and contract files whose direct-versus-clean-room status has no ledger.
`LICENSE`, `NOTICE`, `upstream.json`, and sampled source headers agree on the
pinned revision, but that package-level consistency does not replace per-file
provenance. The authoritative backlog requires a derivation ledger, header scan,
and packed-output check before the provenance phase can be complete.

When the upstream baseline changes, update `upstream.json`, `NOTICE`, the
porting plan, compatibility fixture metadata, and affected source headers in the
same change.
