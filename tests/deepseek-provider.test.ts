import { describe, expect, it } from "vitest";

import {
  OpenAIProvider,
  createProvider,
  type CompletionEvent,
  type CompletionRequest,
  type ModelProvider,
} from "../src/index.js";

interface Capture {
  readonly urls: string[];
  readonly bodies: Record<string, unknown>[];
}

function recording(): { capture: Capture; fetch: typeof fetch } {
  const capture: Capture = { urls: [], bodies: [] };
  const chunks = [
    { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
    {
      choices: [],
      usage: { prompt_tokens: 9, completion_tokens: 2 },
    },
  ];
  const body = `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return {
    capture,
    fetch: async (input, init) => {
      capture.urls.push(String(input));
      capture.bodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  };
}

async function collect(
  provider: ModelProvider,
  request: CompletionRequest,
): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of provider.stream(request)) events.push(event);
  return events;
}

describe("DeepSeek endpoint normalization", () => {
  it("strips the routing prefix and names the output limit max_tokens", async () => {
    const { capture, fetch } = recording();
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      baseURL: "https://api.deepseek.com",
      dialect: "deepseek",
      fetch,
    });

    const events = await collect(provider, {
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 64,
      extraParameters: {},
    });

    expect(capture.bodies[0]).toMatchObject({
      model: "deepseek-chat",
      max_tokens: 64,
    });
    expect(capture.bodies[0]).not.toHaveProperty("max_completion_tokens");
    // An ordinary turn stays on the standard path.
    expect(capture.urls[0]).toBe("https://api.deepseek.com/chat/completions");
    expect(events).toContainEqual({ type: "text-delta", text: "answer" });
    expect(events).toContainEqual({
      type: "usage",
      inputTokens: 9,
      outputTokens: 2,
    });
  });

  it("sends a trailing assistant message as a beta-path prefix", async () => {
    const { capture, fetch } = recording();
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      baseURL: "https://api.deepseek.com",
      dialect: "deepseek",
      fetch,
    });

    await collect(provider, {
      model: "deepseek/deepseek-chat",
      messages: [
        { role: "user", content: "write it" },
        { role: "assistant", content: "partial output" },
      ],
      extraParameters: {},
    });

    expect(capture.urls[0]).toBe(
      "https://api.deepseek.com/beta/chat/completions",
    );
    expect(capture.bodies[0]?.["messages"]).toEqual([
      { role: "user", content: "write it" },
      { role: "assistant", content: "partial output", prefix: true },
    ]);
  });

  it("leaves an OpenAI endpoint's model, output limit, and messages alone", async () => {
    const { capture, fetch } = recording();
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      baseURL: "https://api.openai.com/v1",
      fetch,
    });

    await collect(provider, {
      model: "deepseek/deepseek-chat",
      messages: [
        { role: "user", content: "write it" },
        { role: "assistant", content: "partial output" },
      ],
      maxOutputTokens: 64,
      extraParameters: {},
    });

    expect(capture.urls[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(capture.bodies[0]).toMatchObject({
      model: "deepseek/deepseek-chat",
      max_completion_tokens: 64,
    });
    expect(capture.bodies[0]?.["messages"]).toEqual([
      { role: "user", content: "write it" },
      { role: "assistant", content: "partial output" },
    ]);
  });

  it("selects the DeepSeek dialect and base URL from the model provider", async () => {
    const { capture, fetch } = recording();
    const provider = createProvider(
      {
        name: "deepseek/deepseek-chat",
        provider: "deepseek",
        editFormat: "diff",
        useRepoMap: false,
        maxChatHistoryTokens: 1024,
        useTemperature: true,
        capabilities: {
          streaming: true,
          systemRole: true,
          tools: false,
          images: false,
          documents: false,
          promptCaching: false,
          assistantPrefill: false,
        },
        extraParameters: {},
      },
      { apiKey: "test-key", fetch },
    );

    await collect(provider, {
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 8,
      extraParameters: {},
    });

    expect(capture.urls[0]).toBe("https://api.deepseek.com/chat/completions");
    expect(capture.bodies[0]).toMatchObject({
      model: "deepseek-chat",
      max_tokens: 8,
    });
  });
});
