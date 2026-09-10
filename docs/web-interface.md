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
or zero chooses an available port. These interface flags are CLI-only; model,
provider credentials, Git, and selected files use the normal staged configuration.
No browser opens and no HTML GUI is shipped. Watch and one-shot options cannot
be combined with `--web`.

`LocalWebServer` exposes the adapter-neutral `ApplicationService` over loopback HTTP. The same service contract can back terminal, watcher, or other interfaces; web code does not own model or edit behavior.

The server refuses non-loopback binds and requires an `Authorization: Bearer …` header on every request. Tokens map to application principal IDs and are compared in constant time. Tokens are never accepted in URLs. `POST /sessions` creates an opaque session; snapshot, message, event, and delete routes recheck that the authenticated principal owns it and return 404 rather than revealing another user's session.

`GET /sessions/:id/events` is an SSE stream. `POST /sessions/:id/messages` accepts one bounded JSON message and serializes submissions through that session's queue. Events have per-session sequence IDs and are sent only to clients attached to that session. Request disconnects cancel queued or active application work through an `AbortSignal`.

The CLI constructs `ConcreteApplicationService`; each web session has independent
conversation state and its own queue while sharing one repository. There is no
application-wide mutation lock or optimistic repository version check. Two
authenticated sessions can stage against stale shared state and overwrite or
commit conflicting changes; this is a release-blocking data-integrity risk.
New/out-of-chat writes and model-suggested commands remain denied without an
embedding approver. Malformed JSON and invalid messages return 400, oversized
messages return 413, and internal errors return a generic 500.

Ctrl-C/SIGTERM stops accepting connections, disconnects HTTP/SSE clients, closes
sessions (aborting their work), drains the concrete service queues, and closes
the provider. Startup bind failures also release the service. `DELETE
/sessions/:id` closes an individual session; `/exit` in a message only closes
that application session, not the server.

Use only with trusted local clients for short-lived sessions. Idle expiry,
session/connection quotas, SSE replay and bounded backpressure policy remain R8
work: a slow SSE consumer can accumulate buffered output, and the concrete
service retains session objects until shutdown (DELETE closes access and cancels
work but does not release that retained state). Do not expose this server through a public
proxy or use it as multi-tenant hosting. Tokens grant access to the configured
repository and model budget. Library callers may map distinct tokens to
principals, but that isolates session ownership, not repository files.

This intentionally replaces the pinned upstream
[`aider/gui.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/gui.py)
Streamlit GUI with a small authenticated API. Evidence:
`tests/interface-startup.test.ts` (concrete startup, malformed input, bind failure,
active-turn shutdown), `tests/web-server.test.ts` (principal isolation, SSE,
body limits), and `scripts/package-smoke.mjs` (packed startup and absence of
optional browser/native/audio dependencies).
