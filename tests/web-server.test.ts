import { ServerResponse } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalWebServer,
  TurnPartiallyAppliedError,
  type ApplicationService,
  type ApplicationSession,
  type LocalWebServerOptions,
} from "../src/index.js";

const servers: LocalWebServer[] = [];
afterEach(async () =>
  Promise.all(servers.splice(0).map((server) => server.close())),
);

function service(): ApplicationService {
  return {
    createSession: ({ principal }) => {
      const messages: string[] = [];
      return {
        snapshot: () => ({ principal, messages: [...messages] }),
        submit: async (message, { emit, signal }) => {
          if (signal.aborted) throw signal.reason;
          emit({ type: "text", data: `${principal}:${message}` });
          messages.push(message);
          return { message };
        },
      } satisfies ApplicationSession;
    },
  };
}

async function fixture(
  applicationService = service(),
  options: Partial<LocalWebServerOptions> = {},
) {
  const server = new LocalWebServer({
    ...options,
    service: applicationService,
    tokens: { aliceToken: "alice", bobToken: "bob" },
  });
  servers.push(server);
  const { port } = await server.start();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function request(
  base: string,
  path: string,
  token?: string,
  init: RequestInit = {},
) {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
}

describe("LocalWebServer", () => {
  it("cancels an active POST when the HTTP client disconnects", async () => {
    let entered!: () => void;
    let cancelled!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const aborted = new Promise<void>((resolve) => (cancelled = resolve));
    const applicationService: ApplicationService = {
      createSession: () => ({
        snapshot: () => ({}),
        submit: async (_message, { signal }) => {
          entered();
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener(
              "abort",
              () => {
                cancelled();
                reject(signal.reason);
              },
              { once: true },
            ),
          );
        },
      }),
    };
    const { base } = await fixture(applicationService);
    const { sessionId } = (await (
      await request(base, "/sessions", "aliceToken", { method: "POST" })
    ).json()) as { sessionId: string };
    const controller = new AbortController();
    const pending = request(
      base,
      `/sessions/${sessionId}/messages`,
      "aliceToken",
      {
        method: "POST",
        body: JSON.stringify({ message: "wait" }),
        signal: controller.signal,
      },
    ).catch(() => undefined);
    await started;
    controller.abort();
    await aborted;
    await pending;
  });

  it("disconnects an overflowing SSE client while retaining bounded replay", async () => {
    const applicationService: ApplicationService = {
      createSession: () => ({
        snapshot: () => ({}),
        submit: async (_message, { emit }) => {
          for (let index = 0; index < 8; index += 1)
            emit({ type: "text", data: `${index}:${"x".repeat(256)}` });
          return {};
        },
      }),
    };
    const { base } = await fixture(applicationService, {
      maxBufferedEvents: 2,
      maxClientQueueBytes: 64,
    });
    const { sessionId } = (await (
      await request(base, "/sessions", "aliceToken", { method: "POST" })
    ).json()) as { sessionId: string };
    const originalWrite = ServerResponse.prototype.write;
    const pressure = vi
      .spyOn(ServerResponse.prototype, "write")
      .mockImplementation(function (this: ServerResponse, chunk, ...args) {
        originalWrite.call(this, chunk, ...args);
        return false;
      });
    const events = await request(
      base,
      `/sessions/${sessionId}/events`,
      "aliceToken",
    );
    await request(base, `/sessions/${sessionId}/messages`, "aliceToken", {
      method: "POST",
      body: JSON.stringify({ message: "overflow" }),
    });
    await expect(events.text()).resolves.toContain(": connected");
    pressure.mockRestore();

    const replay = await request(
      base,
      `/sessions/${sessionId}/events`,
      "aliceToken",
      { headers: { "last-event-id": "0" } },
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: "event_history_unavailable",
    });
  });

  it("expires and reclaims sessions while enforcing principal and total quotas", async () => {
    let now = 1_000;
    let closed = 0;
    const applicationService: ApplicationService = {
      createSession: () => ({
        snapshot: () => ({}),
        submit: async () => ({}),
        close: () => {
          closed += 1;
        },
      }),
    };
    const { base } = await fixture(applicationService, {
      now: () => now,
      sessionTtlMs: 10,
      maxSessions: 1,
      maxSessionsPerPrincipal: 1,
      reclamationIntervalMs: 60_000,
    });
    const created = await request(base, "/sessions", "aliceToken", {
      method: "POST",
    });
    const first = (await created.json()) as {
      sessionId: string;
      status: string;
      expiresAt: number;
    };
    expect(first).toMatchObject({ status: "active", expiresAt: 1_010 });
    const quota = await request(base, "/sessions", "bobToken", {
      method: "POST",
    });
    expect(quota.status).toBe(429);
    expect(await quota.json()).toEqual({
      error: "Session quota exceeded",
      code: "session_quota_exceeded",
    });

    now = 1_011;
    const expired = await request(
      base,
      `/sessions/${first.sessionId}`,
      "aliceToken",
    );
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({
      error: "Session expired",
      code: "session_expired",
    });
    expect(
      (await request(base, `/sessions/${first.sessionId}`, "bobToken")).status,
    ).toBe(404);
    expect(closed).toBe(1);
    expect(
      (await request(base, "/sessions", "bobToken", { method: "POST" })).status,
    ).toBe(201);
  });

  it("bounds queued messages and SSE clients with stable quota errors", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const applicationService: ApplicationService = {
      createSession: () => ({
        snapshot: () => ({}),
        submit: async () => {
          entered();
          await blocked;
          return {};
        },
      }),
    };
    const { base } = await fixture(applicationService, {
      maxPendingMessagesPerSession: 1,
      maxEventClientsPerSession: 1,
    });
    const { sessionId } = (await (
      await request(base, "/sessions", "aliceToken", { method: "POST" })
    ).json()) as { sessionId: string };
    const firstMessage = request(
      base,
      `/sessions/${sessionId}/messages`,
      "aliceToken",
      { method: "POST", body: JSON.stringify({ message: "first" }) },
    );
    await started;
    const secondMessage = await request(
      base,
      `/sessions/${sessionId}/messages`,
      "aliceToken",
      { method: "POST", body: JSON.stringify({ message: "second" }) },
    );
    expect(secondMessage.status).toBe(429);
    expect(await secondMessage.json()).toMatchObject({
      code: "message_quota_exceeded",
    });
    release();
    expect((await firstMessage).status).toBe(200);

    const firstEvents = await request(
      base,
      `/sessions/${sessionId}/events`,
      "aliceToken",
    );
    const secondEvents = await request(
      base,
      `/sessions/${sessionId}/events`,
      "aliceToken",
    );
    expect(secondEvents.status).toBe(429);
    expect(await secondEvents.json()).toMatchObject({
      code: "event_client_quota_exceeded",
    });
    await firstEvents.body?.cancel();
  });

  it("replays a bounded event ring and reports an evicted replay cursor", async () => {
    const applicationService: ApplicationService = {
      createSession: () => ({
        snapshot: () => ({}),
        submit: async (_message, { emit }) => {
          emit({ type: "text", data: "one" });
          emit({ type: "text", data: "two" });
          emit({ type: "text", data: "three" });
          return { done: true };
        },
      }),
    };
    const { base } = await fixture(applicationService, {
      maxBufferedEvents: 2,
    });
    const { sessionId } = (await (
      await request(base, "/sessions", "aliceToken", { method: "POST" })
    ).json()) as { sessionId: string };
    await request(base, `/sessions/${sessionId}/messages`, "aliceToken", {
      method: "POST",
      body: JSON.stringify({ message: "go" }),
    });
    const evicted = await request(
      base,
      `/sessions/${sessionId}/events`,
      "aliceToken",
      { headers: { "last-event-id": "0" } },
    );
    expect(evicted.status).toBe(409);
    expect(await evicted.json()).toMatchObject({
      code: "event_history_unavailable",
    });

    const replay = await request(
      base,
      `/sessions/${sessionId}/events`,
      "aliceToken",
      { headers: { "last-event-id": "2" } },
    );
    const reader = replay.body?.getReader();
    let text = "";
    while (!text.includes("id: 4")) {
      const chunk = await reader?.read();
      text += new TextDecoder().decode(chunk?.value);
    }
    expect(text).toContain("id: 3");
    expect(text).toContain("three");
    expect(text).toContain("id: 4");
    expect(text).not.toContain('data: "one"');
    await reader?.cancel();
  });

  it("requires bearer authentication and binds only to loopback", async () => {
    const { base } = await fixture();
    expect(
      (await request(base, "/sessions", undefined, { method: "POST" })).status,
    ).toBe(401);
    expect(
      (await request(base, "/sessions", "wrong", { method: "POST" })).status,
    ).toBe(401);
    const unsafe = new LocalWebServer({
      service: service(),
      tokens: { token: "user" },
      host: "0.0.0.0",
    });
    await expect(unsafe.start()).rejects.toThrow(/loopback/);
  });

  it("isolates session state and ownership by principal", async () => {
    const { base } = await fixture();
    const created = await request(base, "/sessions", "aliceToken", {
      method: "POST",
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    expect(
      (await request(base, `/sessions/${sessionId}`, "bobToken")).status,
    ).toBe(404);
    await request(base, `/sessions/${sessionId}/messages`, "aliceToken", {
      method: "POST",
      body: JSON.stringify({ message: "private" }),
    });
    const state = await request(base, `/sessions/${sessionId}`, "aliceToken");
    expect(await state.json()).toMatchObject({
      state: { principal: "alice", messages: ["private"] },
    });
  });

  it("streams only its session events over SSE and rejects oversized bodies", async () => {
    const { base } = await fixture();
    const first = (await (
      await request(base, "/sessions", "aliceToken", { method: "POST" })
    ).json()) as { sessionId: string };
    const second = (await (
      await request(base, "/sessions", "aliceToken", { method: "POST" })
    ).json()) as { sessionId: string };
    const controller = new AbortController();
    const events = await request(
      base,
      `/sessions/${first.sessionId}/events`,
      "aliceToken",
      { signal: controller.signal },
    );
    const reader = events.body?.getReader();
    expect(reader).toBeDefined();
    await request(
      base,
      `/sessions/${second.sessionId}/messages`,
      "aliceToken",
      { method: "POST", body: JSON.stringify({ message: "other" }) },
    );
    await request(base, `/sessions/${first.sessionId}/messages`, "aliceToken", {
      method: "POST",
      body: JSON.stringify({ message: "mine" }),
    });
    const firstChunk = await reader!.read();
    const secondChunk = await reader!.read();
    const text = new TextDecoder().decode(
      Buffer.concat([
        Buffer.from(firstChunk.value ?? []),
        Buffer.from(secondChunk.value ?? []),
      ]),
    );
    expect(text).toContain("alice:mine");
    expect(text).not.toContain("other");
    controller.abort();

    const tiny = new LocalWebServer({
      service: service(),
      tokens: { token: "user" },
      maxBodyBytes: 5,
    });
    servers.push(tiny);
    const { port } = await tiny.start();
    const tooLarge = await request(
      `http://127.0.0.1:${port}`,
      "/sessions",
      "token",
      { method: "POST" },
    );
    const id = ((await tooLarge.json()) as { sessionId: string }).sessionId;
    expect(
      (
        await request(
          `http://127.0.0.1:${port}`,
          `/sessions/${id}/messages`,
          "token",
          { method: "POST", body: JSON.stringify({ message: "long" }) },
        )
      ).status,
    ).toBe(413);
  });

  it("exposes only allowlisted partial-turn recovery fields", async () => {
    const internalSecret = "raw-provider-secret-must-not-leak";
    const partialService: ApplicationService = {
      createSession: () => ({
        snapshot: () => ({}),
        submit: async () => {
          throw new TurnPartiallyAppliedError(new Error(internalSecret), {
            kind: "turn",
            changedPaths: ["src/changed.ts", "/private/absolute-secret"],
            commit: "a".repeat(40),
            commands: [
              {
                command: `print ${internalSecret}`,
                status: "completed",
                exitCode: 9,
                stdout: internalSecret,
                stderr: internalSecret,
                truncated: true,
              },
            ],
          });
        },
      }),
    };
    const { base } = await fixture(partialService);
    const created = await request(base, "/sessions", "aliceToken", {
      method: "POST",
    });
    const { sessionId } = (await created.json()) as { sessionId: string };
    const response = await request(
      base,
      `/sessions/${sessionId}/messages`,
      "aliceToken",
      { method: "POST", body: JSON.stringify({ message: "change it" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: "Turn partially applied",
      code: "turn_partially_applied",
      partial: {
        changedPaths: ["src/changed.ts"],
        commit: "a".repeat(40),
        commands: [{ status: "completed", exitCode: 9, truncated: true }],
      },
    });
    expect(JSON.stringify(body)).not.toContain(internalSecret);
    expect(JSON.stringify(body)).not.toContain("absolute-secret");
  });

  it("attempts every session cleanup when one close fails", async () => {
    const invoked: number[] = [];
    const closes = [
      () => {
        invoked.push(0);
        return Promise.reject(new Error("first close failed"));
      },
      () => {
        invoked.push(1);
        return Promise.resolve();
      },
    ];
    let created = 0;
    const { server, base } = await fixture({
      createSession: () => ({
        snapshot: () => ({}),
        submit: async () => ({}),
        close: vi.fn(closes[created++]!),
      }),
    });
    await request(base, "/sessions", "aliceToken", { method: "POST" });
    await request(base, "/sessions", "aliceToken", { method: "POST" });
    const sessions = closes.length;

    await expect(server.close()).rejects.toThrow(
      "Unable to close web resources",
    );
    expect(created).toBe(sessions);
    expect(invoked).toEqual([0, 1]);
    servers.splice(servers.indexOf(server), 1);
  });
});
