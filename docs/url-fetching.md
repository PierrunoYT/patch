# URL fetching

Patch's `UrlFetcher` is a bounded interface adapter inspired by pinned aider `aider/scrape.py`. Unlike upstream, Patch intentionally validates every initial and redirected URL against SSRF attacks.

- Only unauthenticated HTTP/HTTPS URLs are accepted.
- Every DNS answer must be globally routable. Connections are pinned to an approved address so DNS rebinding cannot change the destination after validation.
- Redirects repeat URL and DNS validation.
- The default limits are 10 seconds, 2 MiB, and five redirects. Declared and streamed sizes are checked.
- Only UTF-8 textual, JSON, XML, and XHTML responses are returned.
- Caller cancellation aborts the request.

## `/web` ingestion

`/web <url>` fetches one page and puts its readable text into the chat. The
fetcher is constructed the first time the command runs, so a session that never
fetches never loads it.

- **Explicit intent only.** Only a URL the user typed is fetched. A URL a model
  suggests, or one a fetched page links to, is never followed; Patch does not
  detect URLs in prose and offer to scrape them as Aider does. One command means
  exactly one request, and nothing on the page is loaded as a subresource.
- **Source labeling.** The text enters history as a user message that starts
  `Here is the content of <url>:`, naming the URL redirects actually ended at
  rather than the one that was typed. The pinned upstream wording is kept.
- **Token limits.** A page is truncated to a quarter of the model's input
  window, at least 1024 tokens, leaving room for the repository map, the
  selected files, and the conversation that made the page worth fetching. A
  truncated page says so, in the message and in the command's reply.
- **Data, not instructions.** Fetched text is quoted material. It is never
  parsed as a command or an edit, and it carries no authority over the session.
  It is still untrusted text placed in a model's context, so treat a page that
  argues with the model the way you would treat any other untrusted input.

HTML becomes text through `htmlToReadableText`, a dependency-free linear
converter: upstream uses BeautifulSoup and pandoc, neither of which a Node
install should require, and upstream falls back to raw tags when pandoc is
missing where Patch always returns text. Headings, paragraphs, and list items
become Markdown-ish structure; scripts, styles, media, and every attribute
except a link's `href` are dropped, as upstream's `slimdown_html` drops them. A
link target survives only if it is an absolute `http(s)` URL, so no inline
`data:`/`javascript:` payload reaches the model. Malformed markup degrades to
its text, and an unterminated tag ends the document rather than being read as
content.

`loadPlaywrightRenderer()` remains an opt-in library helper for embedding
callers. It renders already-fetched static HTML with every browser network
request blocked; it does not navigate a page or load external
scripts/subresources. Patch dynamically imports `playwright`, which is absent
from the default package, and `/web` never uses it.

The strict SSRF, redirect, size, TLS, and no-subresource policy is an intentional
security difference from the pinned upstream scraper.
