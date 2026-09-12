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
  readonly sessionTtlMs?: number;
  readonly maxSessions?: number;
  readonly maxSessionsPerPrincipal?: number;
  readonly maxPendingMessagesPerSession?: number;
  readonly maxEventClientsPerSession?: number;
  readonly maxBufferedEvents?: number;
  readonly maxBufferedEventBytes?: number;
  readonly maxClientQueueBytes?: number;
  /** Test seam for deterministic expiry without changing production policy. */
  readonly now?: () => number;
  readonly reclamationIntervalMs?: number;
}

interface BufferedEvent {
  readonly sequence: number;
  readonly payload: string;
  readonly bytes: number;
}

interface EventClient {
  readonly response: ServerResponse;
  readonly queue: string[];
  queuedBytes: number;
  blocked: boolean;
}

interface OwnedSession {
  readonly principal: string;
  readonly application: ApplicationSession;
  readonly clients: Set<EventClient>;
  readonly events: BufferedEvent[];
  sequence: number;
  eventBytes: number;
  pendingMessages: number;
  expiresAt: number;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 32;
const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 8;
const DEFAULT_MAX_PENDING_MESSAGES = 4;
const DEFAULT_MAX_EVENT_CLIENTS = 4;
const DEFAULT_MAX_BUFFERED_EVENTS = 256;
const DEFAULT_MAX_BUFFERED_EVENT_BYTES = 256 * 1024;
const DEFAULT_MAX_CLIENT_QUEUE_BYTES = 128 * 1024;

export class LocalWebServer {
  readonly #options: LocalWebServerOptions;
  readonly #sessions = new Map<string, OwnedSession>();
  readonly #expired = new Map<string, string>();
  /** Closes of reclaimed sessions, awaited by `close()` but by no request. */
  readonly #reclaiming = new Set<Promise<void>>();
  readonly #reclaimer: NodeJS.Timeout;
  #server: Server | undefined;
  #closing = false;

  constructor(options: LocalWebServerOptions) {
    this.#options = options;
    if (Object.keys(options.tokens).length === 0)
      throw new Error("At least one authentication token is required");
    if (
      Object.entries(options.tokens).some(
        ([token, principal]) => token.trim() === "" || principal.trim() === "",
      )
    )
      throw new Error("Authentication tokens and principals must not be empty");
    for (const [name, value] of Object.entries(this.#limits())) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer`);
    }
    const interval =
      options.reclamationIntervalMs ??
      Math.min(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, 60_000);
    if (!Number.isSafeInteger(interval) || interval <= 0)
      throw new Error("reclamationIntervalMs must be a positive integer");
    this.#reclaimer = setInterval(() => this.#reclaimExpired(), interval);
    this.#reclaimer.unref();
  }

  #limits() {
    return {
      sessionTtlMs: this.#options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      maxSessions: this.#options.maxSessions ?? DEFAULT_MAX_SESSIONS,
      maxSessionsPerPrincipal:
        this.#options.maxSessionsPerPrincipal ??
        DEFAULT_MAX_SESSIONS_PER_PRINCIPAL,
      maxPendingMessagesPerSession:
        this.#options.maxPendingMessagesPerSession ??
        DEFAULT_MAX_PENDING_MESSAGES,
      maxEventClientsPerSession:
        this.#options.maxEventClientsPerSession ?? DEFAULT_MAX_EVENT_CLIENTS,
      maxBufferedEvents:
        this.#options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS,
      maxBufferedEventBytes:
        this.#options.maxBufferedEventBytes ?? DEFAULT_MAX_BUFFERED_EVENT_BYTES,
      maxClientQueueBytes:
        this.#options.maxClientQueueBytes ?? DEFAULT_MAX_CLIENT_QUEUE_BYTES,
    };
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
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
    clearInterval(this.#reclaimer);
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
    const closingSessions = sessions.map(async (session) => {
      for (const client of session.clients) client.response.end();
      await session.application.close?.();
    });
    const settled = await Promise.allSettled([
      ...closingSessions,
      ...this.#reclaiming,
      closed,
    ]);
    const failures = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0)
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        "Unable to close web resources",
      );
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
      this.#reclaimExpired();
      if (this.#closing)
        return json(response, 503, { error: "Server closing" });
      let url: URL;
      try {
        url = new URL(request.url ?? "/", "http://localhost");
      } catch {
        return json(response, 400, { error: "Invalid URL" });
      }
      if (request.method === "POST" && url.pathname === "/sessions") {
        const limits = this.#limits();
        const principalSessions = [...this.#sessions.values()].filter(
          (session) => session.principal === principal,
        ).length;
        if (
          this.#sessions.size >= limits.maxSessions ||
          principalSessions >= limits.maxSessionsPerPrincipal
        )
          return apiError(
            response,
            429,
            "session_quota_exceeded",
            "Session quota exceeded",
          );
        const sessionId = randomUUID();
        const application = await this.#options.service.createSession({
          principal,
          sessionId,
        });
        if (this.#closing) {
          await application.close?.();
          return;
        }
        const expiresAt = this.#now() + limits.sessionTtlMs;
        this.#sessions.set(sessionId, {
          principal,
          application,
          clients: new Set(),
          events: [],
          sequence: 0,
          eventBytes: 0,
          pendingMessages: 0,
          expiresAt,
        });
        return json(response, 201, { sessionId, status: "active", expiresAt });
      }
      const match = /^\/sessions\/([0-9a-f-]+)(?:\/(events|messages))?$/u.exec(
        url.pathname,
      );
      if (match === null) return json(response, 404, { error: "Not found" });
      const sessionId = match[1] ?? "";
      const operation = match[2];
      const session = this.#sessions.get(sessionId);
      if (session === undefined) {
        if (this.#expired.get(sessionId) === principal)
          return apiError(response, 410, "session_expired", "Session expired");
        return json(response, 404, { error: "Not found" });
      }
      if (session.principal !== principal)
        return json(response, 404, { error: "Not found" });
      // Any request its owner addresses to a session is use of that session, so
      // the idle deadline moves. Reclamation already ran above, so this cannot
      // revive a session that had expired before the request arrived.
      session.expiresAt = this.#now() + this.#limits().sessionTtlMs;

      if (request.method === "GET" && operation === "events") {
        if (session.clients.size >= this.#limits().maxEventClientsPerSession)
          return apiError(
            response,
            429,
            "event_client_quota_exceeded",
            "Event client quota exceeded",
          );
        const after = lastEventId(request);
        if (after instanceof Error)
          return apiError(
            response,
            400,
            "invalid_last_event_id",
            "Invalid Last-Event-ID",
          );
        const oldest = session.events[0]?.sequence ?? session.sequence + 1;
        if (after !== undefined && after < oldest - 1)
          return apiError(
            response,
            409,
            "event_history_unavailable",
            "Event history is no longer available",
          );
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const client: EventClient = {
          response,
          queue: [],
          queuedBytes: 0,
          blocked: false,
        };
        session.clients.add(client);
        response.on("drain", () =>
          flushClient(session, client, this.#limits().maxClientQueueBytes),
        );
        response.on("close", () => session.clients.delete(client));
        writeClient(
          session,
          client,
          ": connected\n\n",
          this.#limits().maxClientQueueBytes,
        );
        for (const event of session.events) {
          if (after === undefined || event.sequence > after)
            writeClient(
              session,
              client,
              event.payload,
              this.#limits().maxClientQueueBytes,
            );
        }
        return;
      }
      if (request.method === "GET" && operation === undefined) {
        return json(response, 200, {
          sessionId,
          status: "active",
          expiresAt: session.expiresAt,
          state: await session.application.snapshot(),
        });
      }
      if (request.method === "DELETE" && operation === undefined) {
        this.#sessions.delete(sessionId);
        for (const client of session.clients) client.response.end();
        await session.application.close?.();
        return json(response, 200, { closed: true });
      }
      if (request.method === "POST" && operation === "messages") {
        if (
          session.pendingMessages >= this.#limits().maxPendingMessagesPerSession
        )
          return apiError(
            response,
            429,
            "message_quota_exceeded",
            "Pending message quota exceeded",
          );
        session.pendingMessages += 1;
        try {
          const body = await readJson(
            request,
            this.#options.maxBodyBytes ?? 64 * 1024,
          );
          if (!isMessageBody(body))
            return json(response, 400, {
              error: "Expected a non-empty message",
            });
          const controller = new AbortController();
          response.on("close", () => {
            if (!response.writableEnded)
              controller.abort(new Error("Client disconnected"));
          });
          const result = await session.application.submit(body.message, {
            signal: controller.signal,
            emit: (event) => this.#emit(session, event),
          });
          this.#emit(session, { type: "complete", data: result });
          // Measured from completion, not from when the request arrived: a turn
          // can take longer than the idle deadline itself.
          session.expiresAt = this.#now() + this.#limits().sessionTtlMs;
          return json(response, 200, { result });
        } finally {
          session.pendingMessages -= 1;
        }
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

  #emit(session: OwnedSession, event: ApplicationEvent): void {
    const limits = this.#limits();
    session.sequence += 1;
    let payload = eventPayload(session.sequence, event);
    if (Buffer.byteLength(payload) > limits.maxBufferedEventBytes)
      payload = eventPayload(session.sequence, {
        type: "error",
        data: { code: "event_too_large" },
      });
    const buffered = {
      sequence: session.sequence,
      payload,
      bytes: Buffer.byteLength(payload),
    };
    session.events.push(buffered);
    session.eventBytes += buffered.bytes;
    while (
      session.events.length > limits.maxBufferedEvents ||
      session.eventBytes > limits.maxBufferedEventBytes
    ) {
      session.eventBytes -= session.events.shift()?.bytes ?? 0;
    }
    for (const client of session.clients)
      writeClient(session, client, payload, limits.maxClientQueueBytes);
  }

  /**
   * Retires idle sessions. A session with a connected event stream is not idle:
   * its client is waiting to be told something, and only message posts used to
   * push the deadline out, so such a session was dropped mid-stream at the TTL.
   *
   * Nothing here is awaited by the request that triggers it. Closing an
   * application waits for its queue to drain, which would otherwise put an
   * unrelated request behind an expiring session's in-flight work.
   */
  #reclaimExpired(): void {
    const now = this.#now();
    const expired = [...this.#sessions.entries()].filter(
      ([, session]) =>
        session.expiresAt <= now &&
        session.pendingMessages === 0 &&
        session.clients.size === 0,
    );
    for (const [id, session] of expired) {
      if (!this.#sessions.delete(id)) continue;
      this.#expired.set(id, session.principal);
      while (this.#expired.size > this.#limits().maxSessions)
        this.#expired.delete(this.#expired.keys().next().value as string);
      for (const client of session.clients) client.response.end();
      const closing = Promise.resolve(session.application.close?.()).catch(
        () => undefined,
      );
      this.#reclaiming.add(closing);
      void closing.finally(() => this.#reclaiming.delete(closing));
    }
  }
}

class BodyLimitError extends Error {}
class InvalidBodyError extends Error {}

/**
 * C0/C1 controls plus the separators and bidirectional overrides that are not
 * in those ranges: U+2028/U+2029 end a line for a consumer that splits on
 * Unicode line breaks, and U+202A-U+202E/U+2066-U+2069 can reorder how a path
 * reads without changing its bytes.
 */
function hasControlCharacter(value: string): boolean {
  return /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
}

function safePartialPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !hasControlCharacter(path) &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    // Drive-relative too (C:file), not only C:/file: both name a location
    // outside this repository's relative namespace.
    !/^[A-Za-z]:/u.test(path) &&
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

function eventPayload(sequence: number, event: ApplicationEvent): string {
  return `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

function writeClient(
  session: OwnedSession,
  client: EventClient,
  payload: string,
  maxQueueBytes: number,
): void {
  if (client.response.writableEnded) {
    session.clients.delete(client);
    return;
  }
  if (!client.blocked) {
    client.blocked = !client.response.write(payload);
    return;
  }
  const bytes = Buffer.byteLength(payload);
  if (client.queuedBytes + bytes > maxQueueBytes) {
    session.clients.delete(client);
    client.response.end();
    return;
  }
  client.queue.push(payload);
  client.queuedBytes += bytes;
}

function flushClient(
  session: OwnedSession,
  client: EventClient,
  maxQueueBytes: number,
): void {
  client.blocked = false;
  while (!client.blocked && client.queue.length > 0) {
    const payload = client.queue.shift() ?? "";
    client.queuedBytes -= Buffer.byteLength(payload);
    writeClient(session, client, payload, maxQueueBytes);
  }
}

function lastEventId(request: IncomingMessage): number | undefined | Error {
  const raw = request.headers["last-event-id"];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw) || !/^\d+$/u.test(raw)) return new Error("invalid");
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : new Error("invalid");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function apiError(
  response: ServerResponse,
  status: number,
  code: string,
  error: string,
): void {
  json(response, status, { error, code });
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
