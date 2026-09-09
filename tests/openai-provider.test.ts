import { describe, expect, it } from "vitest";

import { OpenAIProvider, type CompletionEvent } from "../src/index.js";

async function collect(provider: OpenAIProvider): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of provider.stream({
    model: "custom-model",
    messages: [{ role: "user", content: "hello" }],
    maxOutputTokens: 20,
    temperature: 0.2,
    extraParameters: { seed: 7 },
  })) {
    events.push(event);
  }
  return events;
}

describe("OpenAIProvider", () => {
  it("maps compatible SSE chunks, request options, usage, and finish reasons", async () => {
    let requestedURL = "";
    let requestBody: Record<string, unknown> = {};
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      baseURL: "https://compatible.example/v1",
      defaultHeaders: { "x-test": "yes" },
      fetch: async (input, init) => {
        requestedURL = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const chunks = [
          {
            choices: [
              { delta: { reasoning_content: "think" }, finish_reason: null },
            ],
          },
          {
            choices: [
              {
                delta: {
                  content: "answer",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      function: { name: "edit", arguments: "{" },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 4,
              prompt_tokens_details: { cached_tokens: 3 },
            },
          },
        ];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    await expect(collect(provider)).resolves.toEqual([
      { type: "reasoning-delta", text: "think" },
      { type: "text-delta", text: "answer" },
      {
        type: "tool-call-delta",
        index: 0,
        id: "call-1",
        name: "edit",
        argumentsDelta: "{",
      },
      { type: "finish", reason: "tool-calls" },
      { type: "usage", inputTokens: 11, outputTokens: 4, cachedInputTokens: 3 },
    ]);
    expect(requestedURL).toBe("https://compatible.example/v1/chat/completions");
    expect(requestBody).toMatchObject({
      model: "custom-model",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 20,
      temperature: 0.2,
      seed: 7,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it("classifies HTTP authentication and rate-limit errors", async () => {
    const response = (status: number, message: string) =>
      new Response(
        JSON.stringify({ error: { message, type: "request_error" } }),
        {
          status,
          headers: { "content-type": "application/json" },
        },
      );
    const authentication = new OpenAIProvider({
      apiKey: "bad",
      fetch: async () => response(401, "invalid key"),
    });
    const rateLimit = new OpenAIProvider({
      apiKey: "test",
      fetch: async () => response(429, "slow down"),
    });

    expect((await collect(authentication)).at(-1)).toMatchObject({
      type: "error",
      kind: "authentication",
      retryable: false,
    });
    expect((await collect(rateLimit)).at(-1)).toMatchObject({
      type: "error",
      kind: "rate-limit",
      retryable: true,
    });
  });
});
