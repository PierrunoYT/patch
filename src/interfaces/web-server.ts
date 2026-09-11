import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

import type {
  ApplicationEvent,
  ApplicationService,
  ApplicationSession,
} from "../core/application-service.js";
import { TurnPartiallyAppliedError } from "../core/application-service.js";

export interface LocalWebServerOptions {
  readonly service: ApplicationService;
  readonly tokens: Readonly<Record<string, string>>;
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
}

interface OwnedSession {
  readonly principal: string;
  readonly application: ApplicationSession;
  readonly clients: Set<ServerResponse>;
  sequence: number;
}

export class LocalWebServer {
  readonly #options: LocalWebServerOptions;
  readonly #sessions = new Map<string, OwnedSession>();
  #server: Server | undefined;
  #closing = false;

  constructor(options: LocalWebServerOptions) {
    if (Object.keys(options.tokens).length === 0)
      throw new Error("At least one authentication token is required");
    if (
      Object.entries(options.tokens).some(
        ([token, principal]) => token.trim() === "" || principal.trim() === "",
      )
    )
      throw new Error("Authentication tokens and principals must not be empty");
    this.#options = options;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.#closing) throw new Error("Web server is closed");
    if (this.#server !== undefined)
      throw new Error("Web server is already started");
    const host = this.#options.host ?? "127.0.0.1";
    if (!isLoopback(host))
      throw new Error(
        "The local web server may only bind to a loopback address",
      );
    const server = createServer(
      (request, response) => void this.#handle(request, response),
    );
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.port ?? 0, host, () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((error: unknown) => {
      this.#server = undefined;
      throw error;
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Web server has no TCP address");
    return { host, port: address.port };
  }

  async close(): Promise<void> {
    this.#closing = true;
    const server = this.#server;
    this.#server = undefined;
    const closed =
      server === undefined
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            server.close((error) =>
              error === undefined ? resolve() : reject(error),
            );
            server.closeAllConnections();
          });
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const session of sessions) {
      for (const client of session.clients) client.end();
      await session.application.close?.();
    }
    await closed;
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    const principal = authenticate(request, this.#options.tokens);
    if (principal === undefined)
      return json(response, 401, { error: "Unauthorized" });
    try {
      if (this.#closing)
        return json(response, 503, { error: "Server closing" });
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        return json(response, 400, { error: "Invalid URL" });
      }
      if (request.method === "POST" && url.pathname === "/sessions") {
        const sessionId = randomUUID();
        const application = await this.#options.service.createSession({
          principal,
          sessionId,
        });
        if (this.#closing) {
          await application.close?.();
          return;
        }
        this.#sessions.set(sessionId, {
          principal,
          application,
          clients: new Set(),
          sequence: 0,
        });
        return json(response, 201, { sessionId });
      }
      const match = /^\/sessions\/([0-9a-f-]+)(?:\/(events|messages))?$/u.exec(
        url.pathname,
      );
      if (match === null) return json(response, 404, { error: "Not found" });
      const sessionId = match[1] ?? "";
      const operation = match[2];
      const session = this.#sessions.get(sessionId);
      if (session === undefined || session.principal !== principal)
        return json(response, 404, { error: "Not found" });

      if (request.method === "GET" && operation === "events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(": connected\n\n");
        session.clients.add(response);
        response.on("close", () => session.clients.delete(response));
        return;
      }
      if (request.method === "GET" && operation === undefined) {
        return json(response, 200, {
          sessionId,
          state: await session.application.snapshot(),
        });
      }
      if (request.method === "DELETE" && operation === undefined) {
        this.#sessions.delete(sessionId);
        for (const client of session.clients) client.end();
        await session.application.close?.();
        return json(response, 200, { closed: true });
      }
      if (request.method === "POST" && operation === "messages") {
        const body = await readJson(
          request,
          this.#options.maxBodyBytes ?? 64 * 1024,
        );
        if (!isMessageBody(body))
          return json(response, 400, { error: "Expected a non-empty message" });
        const controller = new AbortController();
        response.on("close", () => {
          if (!response.writableEnded)
            controller.abort(new Error("Client disconnected"));
        });
        const result = await session.application.submit(body.message, {
          signal: controller.signal,
          emit: (event) => emit(session, event),
        });
        emit(session, { type: "complete", data: result });
        return json(response, 200, { result });
      }
      return json(response, 405, { error: "Method not allowed" });
    } catch (error) {
      if (!response.headersSent)
        json(
          response,
          error instanceof BodyLimitError
            ? 413
            : error instanceof InvalidBodyError || error instanceof SyntaxError
              ? 400
              : 500,
          error instanceof TurnPartiallyAppliedError
            ? {
                error: "Turn partially applied",
                code: "turn_partially_applied",
                partial: safePartialResult(error),
              }
            : {
                error:
                  error instanceof BodyLimitError
                    ? error.message
                    : error instanceof InvalidBodyError ||
                        error instanceof SyntaxError
                      ? "Invalid JSON request"
                      : "Request failed",
              },
        );
      else response.end();
    }
  }
}

class BodyLimitError extends Error {}
class InvalidBodyError extends Error {}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function safePartialPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !hasControlCharacter(path) &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/u.test(path) &&
    !path.split(/[\\/]/u).includes("..")
  );
}

function safePartialResult(error: TurnPartiallyAppliedError) {
  return {
    changedPaths: error.changedPaths
      .filter((path) => safePartialPath(path))
      .slice(0, 200),
    commit:
      error.commit !== null &&
      /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu.test(error.commit)
        ? error.commit
        : null,
    commands: error.commands.slice(0, 100).map((command) => ({
      status: command.status,
      exitCode: command.exitCode,
      truncated: command.truncated,
    })),
  };
}

function isLoopback(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

function authenticate(
  request: IncomingMessage,
  tokens: Readonly<Record<string, string>>,
): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer "))
    return undefined;
  const candidate = Buffer.from(authorization.slice(7));
  for (const [token, principal] of Object.entries(tokens)) {
    const expected = Buffer.from(token);
    if (
      candidate.length === expected.length &&
      timingSafeEqual(candidate, expected)
    )
      return principal;
  }
  return undefined;
}

function emit(session: OwnedSession, event: ApplicationEvent): void {
  session.sequence += 1;
  const payload = `id: ${session.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  for (const client of session.clients) client.write(payload);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  if (
    !(request.headers["content-type"] ?? "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw new InvalidBodyError("JSON content type required");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new BodyLimitError("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isMessageBody(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 1 &&
    typeof (value as { message?: unknown }).message === "string" &&
    (value as { message: string }).message.trim() !== ""
  );
}
