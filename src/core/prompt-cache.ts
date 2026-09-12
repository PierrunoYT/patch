import type { ModelSettings } from "../models/settings.js";
import type { CompletionRequest, ModelProvider } from "../providers/events.js";

export async function keepPromptCacheAlive(
  provider: ModelProvider,
  model: ModelSettings,
  request: CompletionRequest,
  pings: number,
  signal?: AbortSignal,
): Promise<number> {
  if (!Number.isInteger(pings) || pings < 0 || pings > 10) {
    throw new RangeError(
      "Prompt cache keepalive pings must be an integer from 0 through 10",
    );
  }
  if (!model.capabilities.promptCaching || pings <= 0) return 0;
  let completed = 0;
  for (let ping = 0; ping < pings; ping += 1) {
    if (signal?.aborted) break;
    for await (const event of provider.stream(
      { ...request, maxOutputTokens: 1 },
      signal,
    )) {
      if (event.type === "finish" && event.reason === "cancelled")
        return completed;
      if (event.type === "error")
        throw new Error(`Cache keepalive failed: ${event.message}`);
    }
    completed += 1;
  }
  return completed;
}

export function cacheablePrefix(
  request: CompletionRequest,
): CompletionRequest | undefined {
  const lastBoundary = request.messages.findLastIndex(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === "text" && part.cacheControl !== undefined,
      ),
  );
  if (lastBoundary < 0) return undefined;
  return {
    ...request,
    messages: request.messages.slice(0, lastBoundary + 1),
  };
}
