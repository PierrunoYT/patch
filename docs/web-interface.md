# Local web interface

`LocalWebServer` exposes the adapter-neutral `ApplicationService` over loopback HTTP. The same service contract can back terminal, watcher, or other interfaces; web code does not own model or edit behavior.

The server refuses non-loopback binds and requires an `Authorization: Bearer …` header on every request. Tokens map to application principal IDs and are compared in constant time. Tokens are never accepted in URLs. `POST /sessions` creates an opaque session; snapshot, message, event, and delete routes recheck that the authenticated principal owns it and return 404 rather than revealing another user's session.

`GET /sessions/:id/events` is an SSE stream. `POST /sessions/:id/messages` accepts one bounded JSON message and serializes submissions through that session's queue. Events have per-session sequence IDs and are sent only to clients attached to that session. Request disconnects cancel queued or active application work through an `AbortSignal`.

Callers must generate high-entropy tokens, keep them out of logs, and apply their own idle-session expiry policy. This intentionally replaces the pinned upstream Streamlit GUI with a small authenticated adapter and explicit isolation boundaries.
