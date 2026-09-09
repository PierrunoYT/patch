# Domain contracts

Patch validates data at subsystem boundaries with Zod and derives TypeScript
types from the same schemas. This keeps runtime validation and compile-time
contracts aligned while provider, repository, and interface adapters are built
independently.

The contracts are internal and may change before the first release.

## Modules

| Module | Contract | Upstream behavior reference |
| --- | --- | --- |
| `src/core/messages.ts` | System, user, assistant, and tool messages; text, image, and PDF content; tool calls | [`chat_chunks.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/chat_chunks.py#L5-L64), [`sendchat.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/sendchat.py#L5-L61) |
| `src/providers/events.ts` | Provider-neutral completion requests and streamed text, reasoning, tool-call, usage, finish, and error events | [`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1419-L1523) |
| `src/edits/types.ts` | Edit formats and create, replace, rewrite, delete, and move operations | [`coders/__init__.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/__init__.py#L1-L34), [`patch_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/patch_coder.py#L13-L93) |
| `src/repository/types.ts` | Repository status, diffs, commit requests/results, and adapter interface | [`repo.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L52-L126), [`repo.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L201-L417) |
| `src/commands/effects.ts` | Typed submit, mode switch, exit, and no-op effects | [`commands.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L30-L203) |
| `src/models/settings.ts` | Normalized model identity, edit formats, limits, prices, secondary models, and capabilities | [`models.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/models.py#L127-L150) |
| `src/core/session.ts` | Serializable configuration and session state | [`base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L88-L201) |

`src/index.ts` is the single source export surface. The npm package does not yet
declare a stable public library API.

## Enforced invariants

- Every object schema is strict, so unknown boundary fields are rejected rather
  than silently discarded.
- Assistant messages require content or at least one tool call.
- Tool results require the corresponding tool-call identifier.
- Token counts, costs, and reflection counters cannot be negative.
- Model limits must be positive and exit codes must fit the portable 0–255
  range.
- Move edits require distinct source and destination paths.
- Session file lists cannot contain duplicates, and one path cannot be both
  editable and read-only.
- Reflection count cannot exceed the configured maximum.

Schema validation does not establish filesystem safety. Paths are intentionally
validated only as non-empty strings at this layer; the Phase 1 filesystem
adapter must resolve them against a canonical root, handle missing targets and
symlinks, and reject escapes immediately before every write.

Provider adapters must translate their SDK-specific structures into these
events and retain unrecognized error details only in the optional `raw` field.
The session core should consume the normalized union and must not import a
provider SDK.
