import { describe, expect, it } from "vitest";

import {
  AnthropicProvider,
  ModelSettingsSchema,
  OpenAIProvider,
  diagnoseProvider,
  type CompletionEvent,
  type ModelProvider,
} from "../src/index.js";

const openAIEnabled = process.env.PATCH_LIVE_OPENAI === "1";
const anthropicEnabled = process.env.PATCH_LIVE_ANTHROPIC === "1";
const deepSeekEnabled = process.env.PATCH_LIVE_DEEPSEEK === "1";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function collect(
  provider: ModelProvider,
  model: string,
  capability: "image" | "prompt-cache" | undefined,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<CompletionEvent[]> {
  const events: CompletionEvent[] = [];
  for await (const event of provider.stream(
    {
      model,
      messages: [
        {
          role: "system",
          content:
            capability === "prompt-cache"
              ? [
                  {
                    type: "text",
                    text: "Reply with only OK.",
                    cacheControl: { type: "ephemeral" },
                  },
                ]
              : "Reply with only OK.",
        },
        {
          role: "user",
          content:
            capability === "image"
              ? [
                  { type: "text", text: "Reply with only OK." },
                  {
                    type: "image",
                    mediaType: "image/png",
                    data: onePixelPng,
                  },
                ]
              : "Confirm.",
        },
      ],
      maxOutputTokens: 16,
      extraParameters: {},
    },
    signal,
  )) {
    events.push(event);
  }
  return events;
}

function assertContract(events: readonly CompletionEvent[]) {
  expect(events.some((event) => event.type === "text-delta")).toBe(true);
  expect(events).toContainEqual({ type: "finish", reason: "stop" });
  expect(
    events.some(
      (event) =>
        event.type === "usage" &&
        event.inputTokens > 0 &&
        event.outputTokens > 0,
    ),
  ).toBe(true);
  expect(events.some((event) => event.type === "error")).toBe(false);
}

function assertSecretSafeDiagnostic(provider: "openai" | "anthropic") {
  const secret = `live-secret-${provider}`;
  const environmentVariable =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const result = diagnoseProvider(
    ModelSettingsSchema.parse({
      name: `${provider}-live-contract`,
      provider,
      editFormat: "diff",
    }),
    { environment: { UNRELATED_SECRET: secret } },
  );
  expect(result.ok).toBe(false);
  expect(result.diagnostics[0]).toMatchObject({
    code: "missing-credential",
    environmentVariable,
  });
  expect(JSON.stringify(result)).not.toContain(secret);
}

describe.skipIf(!openAIEnabled)("opt-in live OpenAI contract", () => {
  it.skipIf(!process.env.OPENAI_API_KEY)(
    "keeps authentication diagnostics secret-safe and streams image input, usage, and stop state",
    async () => {
      assertSecretSafeDiagnostic("openai");
      assertContract(
        await collect(
          new OpenAIProvider({
            apiKey: process.env.OPENAI_API_KEY!,
            timeout: 30_000,
          }),
          process.env.PATCH_LIVE_OPENAI_MODEL ?? "gpt-4o-mini",
          "image",
        ),
      );
    },
  );

  it.skipIf(!process.env.OPENAI_API_KEY)("cancels a request", async () => {
    const events = await collect(
      new OpenAIProvider({
        apiKey: process.env.OPENAI_API_KEY!,
        timeout: 30_000,
      }),
      process.env.PATCH_LIVE_OPENAI_MODEL ?? "gpt-4o-mini",
      undefined,
      AbortSignal.abort(),
    );
    expect(events).toEqual([{ type: "finish", reason: "cancelled" }]);
  });

  it.skipIf(!process.env.OPENAI_API_KEY)(
    "enforces its request timeout",
    async () => {
      const events = await collect(
        new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY!, timeout: 1 }),
        process.env.PATCH_LIVE_OPENAI_MODEL ?? "gpt-4o-mini",
        undefined,
      );
      expect(events.at(-1)).toMatchObject({
        type: "error",
        kind: "timeout",
        retryable: true,
      });
    },
  );
});

describe.skipIf(!anthropicEnabled)("opt-in live Anthropic contract", () => {
  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    "keeps authentication diagnostics secret-safe and streams cache control, usage, and stop state",
    async () => {
      assertSecretSafeDiagnostic("anthropic");
      assertContract(
        await collect(
          new AnthropicProvider({
            apiKey: process.env.ANTHROPIC_API_KEY!,
            timeout: 30_000,
          }),
          process.env.PATCH_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5",
          "prompt-cache",
        ),
      );
    },
  );

  it.skipIf(!process.env.ANTHROPIC_API_KEY)("cancels a request", async () => {
    const events = await collect(
      new AnthropicProvider({
        apiKey: process.env.ANTHROPIC_API_KEY!,
        timeout: 30_000,
      }),
      process.env.PATCH_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5",
      undefined,
      AbortSignal.abort(),
    );
    expect(events).toEqual([{ type: "finish", reason: "cancelled" }]);
  });

  it.skipIf(!process.env.ANTHROPIC_API_KEY)(
    "enforces its request timeout",
    async () => {
      const events = await collect(
        new AnthropicProvider({
          apiKey: process.env.ANTHROPIC_API_KEY!,
          timeout: 1,
        }),
        process.env.PATCH_LIVE_ANTHROPIC_MODEL ?? "claude-haiku-4-5",
        undefined,
      );
      expect(events.at(-1)).toMatchObject({
        type: "error",
        kind: "timeout",
        retryable: true,
      });
    },
  );
});

describe.skipIf(!deepSeekEnabled)("opt-in live DeepSeek contract", () => {
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
          undefined,
        ),
      );
    },
  );
});
