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

When the upstream baseline changes, update `upstream.json`, `NOTICE`, the
porting plan, compatibility fixture metadata, and affected source headers in the
same change.
