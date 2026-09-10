# URL fetching

Patch's `UrlFetcher` is a bounded interface adapter inspired by pinned aider `aider/scrape.py`. Unlike upstream, Patch intentionally validates every initial and redirected URL against SSRF attacks.

- Only unauthenticated HTTP/HTTPS URLs are accepted.
- Every DNS answer must be globally routable. Connections are pinned to an approved address so DNS rebinding cannot change the destination after validation.
- Redirects repeat URL and DNS validation.
- The default limits are 10 seconds, 2 MiB, and five redirects. Declared and streamed sizes are checked.
- Only UTF-8 textual, JSON, XML, and XHTML responses are returned.
- Caller cancellation aborts the request.

`loadPlaywrightRenderer()` is an opt-in library helper. It renders the
already-fetched static HTML with every browser network request blocked; it does
not navigate a page, load external scripts/subresources, or convert HTML to
readable Markdown as Aider does. Patch dynamically imports `playwright`, which
is absent from the default package. URL detection, `/web` ingestion, approval,
source labeling, token limits, and application prompt wiring are not
implemented.

The strict SSRF, redirect, size, TLS, and no-subresource policy is an intentional
security difference from the pinned upstream scraper.
