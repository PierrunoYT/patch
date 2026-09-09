import { afterEach, describe, expect, it } from "vitest";

import {
  LocalWebServer,
  type ApplicationService,
  type ApplicationSession,
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

async function fixture() {
  const server = new LocalWebServer({
    service: service(),
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
});
