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
for the 63 source files and runtime resources directly ported or behaviorally
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

The ledger is marker-driven and cannot prove that every upstream product file
has a disposition or that an adaptation missing its marker will be discovered.
The independent [2026-09-15 source inventory](aider-source-inventory-2026-09-15.md)
starts from the pinned aider Git tree and classifies all 80 product modules, both
model resources, and all 58 query files. The ledger answers which Patch files
identify direct derivation; the inventory answers what happened to each pinned
upstream file. Neither alone proves semantic equivalence.

These are intentionally separate evidence boundaries rather than inputs to one
recursive hash graph:

1. the direct-derivation ledger verifies attribution carried by Patch source and
   packaged runtime resources;
2. each dated Git-tree inventory verifies that every upstream product source and
   resource has a disposition at the audited revisions; and
3. the fixture manifest verifies the modules imported directly by the
   regeneration driver against the pinned commit and checked-out bytes.

Patch does not execute aider or Python, so aider's transitive Python import graph
is not a Patch runtime dependency contract. It also varies with installed
optional dependencies and exercised branches. Recursively hashing that graph or
blanket-hashing all upstream resources would not prove behavioral equivalence
and would duplicate the source inventory without replacing it. A new direct
fixture import must enter `fixtureSources`; a future driver that directly reads
an upstream resource must pin that resource specifically. This scoped policy
does not claim transitive-dependency or general resource-file integrity.

When the upstream baseline changes, update `upstream.json`, `NOTICE`, the
porting plan, compatibility fixture metadata, and affected source headers in the
same change.
