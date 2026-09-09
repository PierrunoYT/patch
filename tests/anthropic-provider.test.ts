import { describe, expect, it } from "vitest";

import { AnthropicProvider, type CompletionEvent } from "../src/index.js";

async function collect(
  provider: AnthropicProvider,
): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of provider.stream({
    model: "claude-test",
    messages: [
      {
        role: "system",
        content: [
          { type: "text", text: "system", cacheControl: { type: "ephemeral" } },
        ],
      },
      { role: "user", content: "hello" },
    ],
    maxOutputTokens: 50,
    extraParameters: { top_k: 10 },
  })) {
    events.push(event);
  }
  return events;
}

describe("AnthropicProvider", () => {
  it("separates system/cache blocks and maps Messages API streaming", async () => {
    let requestBody: Record<string, unknown> = {};
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      baseURL: "https://anthropic.example",
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const events = [
          {
            type: "message_start",
            message: {
              usage: { input_tokens: 12, cache_read_input_tokens: 5 },
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "think" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "answer" },
          },
          {
            type: "content_block_start",
            index: 2,
            content_block: {
              type: "tool_use",
              id: "tool-1",
              name: "edit",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: "{" },
          },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 6 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    await expect(collect(provider)).resolves.toEqual([
      { type: "reasoning-delta", text: "think" },
      { type: "text-delta", text: "answer" },
      {
        type: "tool-call-delta",
        index: 2,
        id: "tool-1",
        name: "edit",
        argumentsDelta: "",
      },
      { type: "tool-call-delta", index: 2, argumentsDelta: "{" },
      { type: "usage", inputTokens: 12, outputTokens: 6, cachedInputTokens: 5 },
      { type: "finish", reason: "tool-calls" },
    ]);
    expect(requestBody).toMatchObject({
      model: "claude-test",
      system: [
        { type: "text", text: "system", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 50,
      top_k: 10,
      stream: true,
    });
  });

  it("classifies authentication failures without credentials", async () => {
    const provider = new AnthropicProvider({
      apiKey: "bad",
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "invalid key" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    });

    expect((await collect(provider)).at(-1)).toMatchObject({
      type: "error",
      kind: "authentication",
      retryable: false,
    });
  });
});
