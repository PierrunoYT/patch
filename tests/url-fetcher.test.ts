import {
  createServer,
  get,
  type IncomingMessage,
  type RequestListener,
  type Server,
} from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  UnsafeUrlError,
  UrlContentTypeError,
  UrlFetcher,
  UrlFetchError,
  UrlSizeLimitError,
} from "../src/index.js";

const servers: Server[] = [];

async function serverUrl(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

const publicResolver = async () => [
  { address: "93.184.216.34", family: 4 as const },
];

function localTransport(localUrl: string) {
  return (url: URL, _target: unknown, signal: AbortSignal) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(
        `${localUrl}${url.pathname}${url.search}`,
        { signal },
        resolve,
      );
      request.once("error", reject);
    });
}

function publicUrl(localUrl: string): string {
  return localUrl.replace("127.0.0.1", "public.test");
}

describe("UrlFetcher", () => {
  it("rejects private, credentialed, and non-HTTP targets", async () => {
    const fetcher = new UrlFetcher();
    await expect(fetcher.authorize("http://127.0.0.1/")).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    await expect(
      fetcher.authorize("http://user@example.com/"),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      fetcher.authorize("file:///etc/passwd"),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects a redirect whose newly resolved destination is private", async () => {
    const url = await serverUrl((_request, response) => {
      response
        .writeHead(302, { location: "http://internal.test/secret" })
        .end();
    });
    const fetcher = new UrlFetcher(
      async (hostname) =>
        hostname === "public.test"
          ? [{ address: "93.184.216.34", family: 4 }]
          : [{ address: "127.0.0.1", family: 4 }],
      localTransport(url),
    );
    await expect(fetcher.fetch(publicUrl(url))).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("enforces declared and streamed size limits and textual content types", async () => {
    const url = await serverUrl((request, response) => {
      if (request.url === "/binary") {
        response.writeHead(200, { "content-type": "image/png" }).end("png");
      } else if (request.url === "/declared") {
        response
          .writeHead(200, {
            "content-type": "text/plain",
            "content-length": "50",
          })
          .end("short");
      } else {
        response
          .writeHead(200, { "content-type": "text/plain" })
          .end("a".repeat(50));
      }
    });
    const fetcher = new UrlFetcher(publicResolver, localTransport(url));
    await expect(
      fetcher.fetch(`${publicUrl(url)}/binary`, { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(UrlContentTypeError);
    await expect(
      fetcher.fetch(`${publicUrl(url)}/declared`, { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(UrlSizeLimitError);
    await expect(
      fetcher.fetch(`${publicUrl(url)}/streamed`, { maxBytes: 10 }),
    ).rejects.toBeInstanceOf(UrlSizeLimitError);
  });

  it("times out, honors cancellation, and invokes an optional renderer only for HTML", async () => {
    const url = await serverUrl((_request, response) => {
      setTimeout(
        () =>
          response
            .writeHead(200, { "content-type": "text/html" })
            .end("<p>raw</p>"),
        50,
      );
    });
    const fetcher = new UrlFetcher(publicResolver, localTransport(url));
    await expect(
      fetcher.fetch(publicUrl(url), { timeoutMs: 5 }),
    ).rejects.toBeInstanceOf(UrlFetchError);

    const controller = new AbortController();
    controller.abort();
    await expect(
      fetcher.fetch(publicUrl(url), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(UrlFetchError);

    const fastUrl = await serverUrl((_request, response) =>
      response
        .writeHead(200, { "content-type": "text/html" })
        .end("<p>raw</p>"),
    );
    const fastFetcher = new UrlFetcher(publicResolver, localTransport(fastUrl));
    const rendered = await fastFetcher.fetch(publicUrl(fastUrl), {
      browser: async ({ url: finalUrl, content }) => ({
        url: finalUrl,
        contentType: "text/html",
        content: content.replace("raw", "rendered"),
      }),
    });
    expect(rendered).toMatchObject({
      content: "<p>rendered</p>",
      rendered: true,
    });
  });
});
