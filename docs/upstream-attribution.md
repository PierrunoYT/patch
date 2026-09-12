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

[`direct-derivations.json`](direct-derivations.json) is the authoritative ledger
for the 61 source files and runtime resources directly ported or behaviorally
adapted from the pinned Aider revision. Each entry records the local path, every
upstream Aider path used in that file, full revision, modification status,
artifact kind, and Apache-2.0 license. Multiple derivations in one local file are
listed together; for example, the fenced SEARCH/REPLACE strategy and generated
commit-message prompt record their additional sources.

`npm run provenance:check`, included in `npm run check`, compares the ledger to
`upstream.json`; scans `src/` for unlisted Aider derivation markers; rejects
duplicate, stale, unsorted, or out-of-tree entries; and verifies the path,
revision, modification statement, and Apache line in every listed file. Package
smoke testing independently verifies that the installed package carries this
ledger and policy document. The C# query's explicit upstream MIT notice is not
an Aider derivation and is deliberately outside this Apache ledger. Generated
compatibility fixtures remain governed by blob hashes and the separate
[fixture provenance boundary](compatibility-fixtures.md#what-the-exporter-refuses),
not by this direct-port ledger.

When the upstream baseline changes, update `upstream.json`, `NOTICE`, the
porting plan, compatibility fixture metadata, and affected source headers in the
same change.
