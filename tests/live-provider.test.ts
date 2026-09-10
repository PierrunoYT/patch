import { describe, expect, it } from "vitest";

import {
  AnthropicProvider,
  OpenAIProvider,
  type CompletionEvent,
  type ModelProvider,
} from "../src/index.js";

const enabled = process.env.PATCH_LIVE_PROVIDERS === "1";

async function collect(
  provider: ModelProvider,
  model: string,
  cachedSystem = false,
): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of provider.stream(
    {
      model,
      messages: [
        {
          role: "system",
          content: cachedSystem
            ? [
                {
                  type: "text",
                  text: "Reply with only OK.",
                  cacheControl: { type: "ephemeral" },
                },
              ]
            : "Reply with only OK.",
        },
        { role: "user", content: "Confirm." },
      ],
      maxOutputTokens: 16,
      extraParameters: {},
    },
    AbortSignal.timeout(30_000),
  )) {
    events.push(event);
  }
  return events;
}

function assertContract(events: readonly CompletionEvent[]) {
  expect(events.some((event) => event.type === "text-delta")).toBe(true);
  expect(events.some((event) => event.type === "finish")).toBe(true);
  expect(events.some((event) => event.type === "usage")).toBe(true);
  expect(events.some((event) => event.type === "error")).toBe(false);
}

describe.skipIf(!enabled)("opt-in live provider contracts", () => {
  it.skipIf(!process.env.OPENAI_API_KEY)(
    "streams OpenAI usage and finish state",
    async () => {
      assertContract(
        await collect(
          new OpenAIProvider({
            apiKey: process.env.OPENAI_API_KEY!,
            timeout: 30_000,
          }),
          process.env.PATCH_LIVE_OPENAI_MODEL ?? "gpt-4o-mini",
        ),
      );
    },
  );

  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    "streams Anthropic with a cache-control system block",
    async () => {
      assertContract(
        await collect(
          new AnthropicProvider({
            apiKey: process.env.ANTHROPIC_API_KEY!,
            timeout: 30_000,
          }),
          process.env.PATCH_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5",
          true,
        ),
      );
    },
  );

  it.skipIf(!process.env.DEEPSEEK_API_KEY)(
    "streams the advertised DeepSeek-compatible contract",
    async () => {
      assertContract(
        await collect(
          new OpenAIProvider({
            apiKey: process.env.DEEPSEEK_API_KEY!,
            baseURL: "https://api.deepseek.com",
            timeout: 30_000,
          }),
          process.env.PATCH_LIVE_DEEPSEEK_MODEL ?? "deepseek-chat",
        ),
      );
    },
  );
});
