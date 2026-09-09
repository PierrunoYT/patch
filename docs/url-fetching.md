# URL fetching

Patch's `UrlFetcher` is a bounded interface adapter inspired by pinned aider `aider/scrape.py`. Unlike upstream, Patch intentionally validates every initial and redirected URL against SSRF attacks.

- Only unauthenticated HTTP/HTTPS URLs are accepted.
- Every DNS answer must be globally routable. Connections are pinned to an approved address so DNS rebinding cannot change the destination after validation.
- Redirects repeat URL and DNS validation.
- The default limits are 10 seconds, 2 MiB, and five redirects. Declared and streamed sizes are checked.
- Only UTF-8 textual, JSON, XML, and XHTML responses are returned.
- Caller cancellation aborts the request.

JavaScript rendering is opt-in through `loadPlaywrightRenderer()`. Patch dynamically imports `playwright`; it is not a dependency of the default package. Playwright renders the already-vetted HTML while blocking all browser network requests, preventing DNS rebinding and private subresource access. Install Playwright and Chromium separately only when rendering is needed.

This is an intentional security difference from the pinned upstream scraper, which follows redirects without destination or response-size validation.
