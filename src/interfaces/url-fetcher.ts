/**
 * URL scraping behavior adapted from aider/scrape.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch with bounded Node.js fetching, DNS-pinned SSRF protection, and an
 * explicitly loaded optional Playwright enhancement.
 * Licensed under the Apache License, Version 2.0.
 */

import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const blockedIpv4Addresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}
const blockedIpv6Addresses = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
}

export interface UrlFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly signal?: AbortSignal;
  readonly browser?: BrowserRenderer;
}

export interface FetchedUrl {
  readonly url: string;
  readonly contentType: string;
  readonly content: string;
  readonly rendered: boolean;
}

export interface BrowserRenderRequest {
  readonly url: string;
  readonly content: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export type BrowserRenderer = (
  request: BrowserRenderRequest,
) => Promise<{ content: string; contentType: string; url: string }>;

export class UrlFetchError extends Error {
  override readonly name: string = "UrlFetchError";
}

export class UnsafeUrlError extends UrlFetchError {
  override readonly name = "UnsafeUrlError";
}

export class UrlSizeLimitError extends UrlFetchError {
  override readonly name = "UrlSizeLimitError";
}

export class UrlContentTypeError extends UrlFetchError {
  override readonly name = "UrlContentTypeError";
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;

function parseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${input}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new UnsafeUrlError("Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("URL credentials are not allowed");
  }
  return url;
}

function addressFamily(address: string): "ipv4" | "ipv6" {
  return isIP(address) === 4 ? "ipv4" : "ipv6";
}

function assertPublicAddress(address: string): void {
  const family = addressFamily(address);
  const blocked =
    family === "ipv4"
      ? blockedIpv4Addresses.check(address, family)
      : blockedIpv6Addresses.check(address, family);
  if (isIP(address) === 0 || blocked) {
    throw new UnsafeUrlError(
      `URL resolves to a non-public address: ${address}`,
    );
  }
}

async function defaultResolveHost(
  hostname: string,
): Promise<ResolvedAddress[]> {
  if (isIP(hostname) !== 0) {
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) {
      throw new UnsafeUrlError(`Unsupported address family for ${address}`);
    }
    return { address, family };
  });
}

function contentTypeOf(response: IncomingMessage): string {
  return (
    (response.headers["content-type"] ?? "")
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

function assertTextContentType(contentType: string): void {
  if (
    !contentType.startsWith("text/") &&
    !["application/json", "application/xml", "application/xhtml+xml"].includes(
      contentType,
    )
  ) {
    throw new UrlContentTypeError(
      contentType === ""
        ? "The response has no content type"
        : `Unsupported content type: ${contentType}`,
    );
  }
}

export class UrlFetcher {
  readonly #resolveHost: ResolveHost;
  readonly #request: (
    url: URL,
    target: ResolvedAddress,
    signal: AbortSignal,
  ) => Promise<IncomingMessage>;

  constructor(
    resolveHost: ResolveHost = defaultResolveHost,
    request: (
      url: URL,
      target: ResolvedAddress,
      signal: AbortSignal,
    ) => Promise<IncomingMessage> = requestPinned,
  ) {
    this.#resolveHost = resolveHost;
    this.#request = request;
  }

  async authorize(input: string): Promise<URL> {
    const url = parseUrl(input);
    const addresses = await this.#resolveHost(url.hostname);
    if (addresses.length === 0) {
      throw new UnsafeUrlError(`URL host did not resolve: ${url.hostname}`);
    }
    for (const { address } of addresses) assertPublicAddress(address);
    return url;
  }

  async fetch(
    input: string,
    options: UrlFetchOptions = {},
  ): Promise<FetchedUrl> {
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxRedirects = options.maxRedirects ?? 5;
    if (maxBytes < 1 || timeoutMs < 1 || maxRedirects < 0) {
      throw new UrlFetchError("Fetch limits must be positive");
    }
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("URL fetch timed out")),
      timeoutMs,
    );
    try {
      if (options.signal?.aborted) abort();
      const fetched = await this.#fetchHttp(
        input,
        maxBytes,
        maxRedirects,
        controller.signal,
      );
      if (
        options.browser === undefined ||
        fetched.contentType !== "text/html"
      ) {
        return fetched;
      }
      const rendered = await options.browser({
        url: fetched.url,
        content: fetched.content,
        maxBytes,
        timeoutMs,
        signal: controller.signal,
      });
      assertTextContentType(rendered.contentType);
      if (Buffer.byteLength(rendered.content) > maxBytes) {
        throw new UrlSizeLimitError(
          "Rendered page exceeds the configured size limit",
        );
      }
      return { ...rendered, rendered: true };
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof UrlFetchError)) {
        throw new UrlFetchError("URL fetch was cancelled or timed out", {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async #fetchHttp(
    input: string,
    maxBytes: number,
    redirectsLeft: number,
    signal: AbortSignal,
  ): Promise<FetchedUrl> {
    const url = await this.authorize(input);
    const addresses = await this.#resolveHost(url.hostname);
    const target = addresses[0];
    if (target === undefined)
      throw new UnsafeUrlError("URL host did not resolve");
    assertPublicAddress(target.address);
    const response = await this.#request(url, target, signal);
    const status = response.statusCode ?? 0;
    if (
      status >= 300 &&
      status < 400 &&
      response.headers.location !== undefined
    ) {
      response.resume();
      if (redirectsLeft === 0)
        throw new UrlFetchError("Too many URL redirects");
      return this.#fetchHttp(
        new URL(response.headers.location, url).href,
        maxBytes,
        redirectsLeft - 1,
        signal,
      );
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new UrlFetchError(`URL request failed with HTTP ${status}`);
    }
    const contentType = contentTypeOf(response);
    assertTextContentType(contentType);
    const declaredLength = Number(response.headers["content-length"] ?? 0);
    if (declaredLength > maxBytes) {
      response.destroy();
      throw new UrlSizeLimitError(
        "URL response exceeds the configured size limit",
      );
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        response.destroy();
        throw new UrlSizeLimitError(
          "URL response exceeds the configured size limit",
        );
      }
      chunks.push(buffer);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch (error) {
      throw new UrlFetchError("URL response is not valid UTF-8 text", {
        cause: error,
      });
    }
    return { url: url.href, contentType, content, rendered: false };
  }
}

function requestPinned(
  url: URL,
  target: ResolvedAddress,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: target.address,
        family: target.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Host: url.host, "User-Agent": "Patch/0.0" },
        servername: url.hostname,
        signal,
      },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
}

export async function loadPlaywrightRenderer(): Promise<BrowserRenderer> {
  const packageName = "playwright";
  let playwright: unknown;
  try {
    playwright = await import(packageName);
  } catch (error) {
    throw new UrlFetchError(
      "Playwright is optional; install playwright and its Chromium browser to enable rendering",
      { cause: error },
    );
  }
  const api = playwright as {
    chromium: {
      launch(): Promise<{
        newPage(): Promise<{
          route(
            pattern: string,
            handler: (route: { abort(): Promise<void> }) => Promise<void>,
          ): Promise<void>;
          setContent(
            content: string,
            options: { waitUntil: string; timeout: number },
          ): Promise<void>;
          content(): Promise<string>;
          close(): Promise<void>;
        }>;
        close(): Promise<void>;
      }>;
    };
  };
  return async ({ url, content: source, maxBytes, timeoutMs, signal }) => {
    const browser = await api.chromium.launch();
    const page = await browser.newPage();
    try {
      // Render only the already-vetted response. Blocking every browser request
      // prevents browser-side DNS rebinding and private subresource access.
      await page.route("**/*", async (route) => route.abort());
      if (signal.aborted) throw signal.reason;
      await page.setContent(source, { waitUntil: "load", timeout: timeoutMs });
      if (signal.aborted) throw signal.reason;
      const content = await page.content();
      if (Buffer.byteLength(content) > maxBytes) {
        throw new UrlSizeLimitError(
          "Rendered page exceeds the configured size limit",
        );
      }
      return {
        url,
        contentType: "text/html",
        content,
      };
    } finally {
      await page.close();
      await browser.close();
    }
  };
}
