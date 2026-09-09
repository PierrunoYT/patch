import { describe, expect, it } from "vitest";

import {
  CompletionRequestSchema,
  FakeProvider,
  type CompletionEvent,
} from "../src/index.js";

const request = CompletionRequestSchema.parse({
  model: "test/model",
  messages: [{ role: "user", content: "Make a change" }],
});

async function collect(provider: FakeProvider, signal?: AbortSignal) {
  const events: CompletionEvent[] = [];
  for await (const event of provider.stream(request, signal)) {
    events.push(event);
  }
  return events;
}

describe("FakeProvider", () => {
  it("replays provider-neutral stream details exactly", async () => {
    const actions = [
      { type: "reasoning-delta", text: "Considering" },
      { type: "text-delta", text: "Updated " },
      { type: "text-delta", text: "the file." },
      {
        type: "tool-call-delta",
        index: 0,
        id: "call-1",
        name: "edit",
        argumentsDelta: '{"path":',
      },
      {
        type: "tool-call-delta",
        index: 0,
        argumentsDelta: '"src/app.ts"}',
      },
      { type: "usage", inputTokens: 21, outputTokens: 13, cost: 0.004 },
      { type: "finish", reason: "length" },
    ] as const;
    const provider = new FakeProvider([{ actions }]);

    await expect(collect(provider)).resolves.toEqual(actions);
    expect(provider.requests).toEqual([request]);
    expect(provider.remainingTurns).toBe(0);
  });

  it("scripts a retryable provider failure followed by a successful turn", async () => {
    const provider = new FakeProvider([
      {
        actions: [
          {
            type: "error",
            kind: "rate-limit",
            message: "Try again",
            retryable: true,
          },
        ],
      },
      {
        actions: [
          { type: "text-delta", text: "Recovered" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);

    await expect(collect(provider)).resolves.toEqual([
      {
        type: "error",
        kind: "rate-limit",
        message: "Try again",
        retryable: true,
      },
    ]);
    await expect(collect(provider)).resolves.toEqual([
      { type: "text-delta", text: "Recovered" },
      { type: "finish", reason: "stop" },
    ]);
    expect(provider.requests).toHaveLength(2);
  });

  it("stops a delayed turn deterministically when cancelled", async () => {
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: "Before cancellation" },
          { type: "delay", milliseconds: 1_000 },
          { type: "text-delta", text: "Must not be emitted" },
        ],
      },
    ]);
    const controller = new AbortController();
    const events: CompletionEvent[] = [];

    for await (const event of provider.stream(request, controller.signal)) {
      events.push(event);
      if (event.type === "text-delta") {
        controller.abort();
      }
    }

    expect(events).toEqual([
      { type: "text-delta", text: "Before cancellation" },
      { type: "finish", reason: "cancelled" },
    ]);
  });

  it("rejects malformed scripts before a request is made", () => {
    expect(
      () =>
        new FakeProvider([
          {
            actions: [{ type: "usage", inputTokens: -1, outputTokens: 0 }],
          },
        ]),
    ).toThrow();
  });

  it("fails clearly when the script has no remaining turn", async () => {
    const provider = new FakeProvider([]);

    await expect(collect(provider)).rejects.toThrow(
      "No fake provider turn scripted for request 1",
    );
    expect(provider.requests).toEqual([]);
  });
});
