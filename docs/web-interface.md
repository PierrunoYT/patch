# Local web interface

Start the experimental local API with:

```sh
# Run in a private directory outside the repository. Do not commit the token.
node --input-type=module -e "import {randomBytes} from 'node:crypto'; import {writeFileSync} from 'node:fs'; writeFileSync('patch-token', randomBytes(32).toString('hex'), {mode: 0o600, flag: 'wx'});"
patch --web --web-token-file /absolute/private/path/patch-token --model 4o file.ts
```

Protect the token with a user-only ACL on Windows. Startup accepts 32–256 ASCII
letters, digits, underscores or hyphens after trimming surrounding whitespace;
length validation is not a substitute for cryptographic randomness. The CLI
never prints token contents and uses one principal, `local`. It prints the
listening address on `127.0.0.1`; `--web-port 8080` chooses a port, and omitted
or zero chooses an available port. `web`, `web-port`, and `web-token-file` are
staged like other configuration, but only a command-line `--web-port` or
`--web-token-file` without `--web` is refused; a persisted one is ignored by a
terminal run. Model, provider credentials, Git, and selected files use the
normal staged configuration.
No browser opens and no HTML GUI is shipped. The browser GUI is **deferred**
(wanted, not scheduled), as recorded in the
[P2 scope decision](../PORTING_PLAN.md#ancillary-feature-dispositions--p2-item-7).
The API is not GUI parity; its session-policy and approval UX work must precede
a GUI. Watch and one-shot options cannot be combined with `--web`.

`LocalWebServer` exposes the adapter-neutral `ApplicationService` over loopback HTTP. The same service contract can back terminal, watcher, or other interfaces; web code does not own model or edit behavior.

The server refuses non-loopback binds and requires an `Authorization: Bearer …` header on every request. Tokens map to application principal IDs and are compared in constant time. Tokens are never accepted in URLs. `POST /sessions` creates an opaque session; snapshot, message, event, and delete routes recheck that the authenticated principal owns it and return 404 rather than revealing another user's session.

`GET /sessions/:id/events` is an SSE stream. `POST /sessions/:id/messages` accepts one bounded JSON message and serializes submissions through that session's queue. Events have per-session sequence IDs and are sent only to clients attached to that session. Request disconnects cancel queued or active application work through an `AbortSignal`.

The CLI constructs `ConcreteApplicationService`; each web session has independent
conversation state and its own queue while sharing one repository. Repository
mutations are ordered across those sessions by one process-wide worktree lock,
so a session's checkpoint, apply, commit, checks, approved command, and undo
run as a unit while other sessions keep streaming. A session that resolved its
edits against content another session has since changed fails on the stale
snapshot instead of overwriting the newer content. Separate `patch` processes on
one worktree remain ordered only by Git's own index lock.
New/out-of-chat writes and model-suggested commands remain denied without an
embedding approver. Malformed JSON and invalid messages return 400, oversized
messages return 413, and internal errors return a generic 500.

Ctrl-C/SIGTERM stops accepting connections, disconnects HTTP/SSE clients, closes
all sessions concurrently (aborting and draining their work), and closes every
owned provider. Cleanup attempts every session and socket even if one close
fails. Startup bind failures also release the service. `DELETE
/sessions/:id` closes an individual session; `/exit` in a message only closes
that application session, not the server.

A failed turn can have written files or created commits. The service may attach
that state to `TurnPartiallyAppliedError`. The authenticated message route keeps
HTTP 500 and returns this stable recovery shape:

```json
{
  "error": "Turn partially applied",
  "code": "turn_partially_applied",
  "partial": {
    "changedPaths": ["src/changed.ts"],
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "commands": [{ "status": "completed", "exitCode": 9, "truncated": false }]
  }
}
```

Paths are bounded, repository-relative values carrying no control, format, or
line-separator character, and no drive letter in any form, including the
drive-relative `C:file`; invalid entries are omitted. A commit is a validated 40- or 64-hex Git object ID or `null`. Command
text and output are never included, only bounded status metadata. The underlying
cause and error message are also omitted, so credentials or raw diagnostics
cannot cross the HTTP boundary. Unexpected errors remain `{ "error": "Request
failed" }`. SSE may already contain progress events; inspect the reported paths
and repository before retrying.

Use only with trusted local clients. A session expires after 30 idle minutes.
Idle means nothing is using it: any request its owner addresses to the session
moves the deadline, active message work is never reclaimed, completion resets
the deadline again because a turn can outlast it, and a session with a connected
event stream is not idle at all — its client is waiting to be told something.
Reclamation closes its SSE clients and application session, and no request waits
for that close, so an expiring session's shutdown cannot delay an unrelated
one. Defaults allow 32
sessions total, eight per principal, four pending message requests and four SSE
clients per session. The server retains at most 256 events and 256 KiB per
session for `Last-Event-ID` replay, and at most 128 KiB queued behind each slow
client; a client exceeding that bound is disconnected and can reconnect from
its last event ID. If that cursor has been evicted, replay returns 409 instead
of silently skipping events. These library options are configurable only by an
embedding; the CLI intentionally uses the safe defaults. Do not expose this server through a public
proxy or use it as multi-tenant hosting. Tokens grant access to the configured
repository and model budget. Library callers may map distinct tokens to
principals, but that isolates session ownership, not repository files.

Session creation and snapshots return `status: "active"` and an epoch-millisecond
`expiresAt`. Stable JSON errors are `session_expired` (410, only to its owner),
`event_history_unavailable` (409), `session_quota_exceeded`,
`message_quota_exceeded`, and `event_client_quota_exceeded` (429), and
`invalid_last_event_id` (400). A different principal receives 404 for another
principal's active or expired session. Explicit DELETE returns `{ "closed":
true }`; it is not reported later as expiry. Authentication remains 401.

This intentionally replaces the pinned upstream
[`aider/gui.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/gui.py)
Streamlit GUI with a small authenticated API. Evidence:
`tests/interface-startup.test.ts` (concrete startup, malformed input, bind failure,
active-turn shutdown, post-write recovery matching disk), `tests/web-server.test.ts`
(principal/session isolation, SSE replay, forced transport backpressure,
disconnect cancellation, quotas, expiry, body limits, and partial-result
redaction), `tests/worktree-serialization.test.ts` (simultaneous direct terminal,
actual watch-mode, and loopback HTTP writes with no overlapping authorization
region), and
`scripts/package-smoke.mjs` (packed startup and absence of
optional browser/native/audio dependencies).
