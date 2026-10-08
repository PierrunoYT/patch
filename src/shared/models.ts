import type { UsageTotals } from './chat';

export type Provider = 'anthropic' | 'openai';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelOption {
  id: string;
  label: string;
  provider: Provider;
  // Context window in tokens, from the providers' model pages (October 2026).
  contextWindow: number;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', contextWindow: 1_000_000 },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', contextWindow: 1_000_000 },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200_000 },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai', contextWindow: 1_050_000 },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', provider: 'openai', contextWindow: 1_050_000 },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', provider: 'openai', contextWindow: 1_050_000 },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', provider: 'openai', contextWindow: 1_050_000 },
];

// The context window of a built-in model; null for a model id entered by hand, whose window is unknown.
export function contextWindow(model: string): number | null {
  return MODEL_OPTIONS.find((option) => option.id === model)?.contextWindow ?? null;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

// Cheap model used for background work (chat titles, Compact chat summaries, commit messages) and the finder subagent.
export const SMALL_MODELS: Record<Provider, string> = {
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
};

// Mid-size model the task subagent can use. Always the chat's own provider.
export const MID_MODELS: Record<Provider, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-6.1-sol',
};

export type SubagentModelChoice = 'same' | 'mid' | 'small';

export const DEFAULT_SUBAGENT_MODEL: SubagentModelChoice = 'same';

// The choice is meant to save money, so it never moves task to a model that costs more than the chat's: a chat on the
// small model keeps it when "mid" is chosen. Without a known price for both, the chosen model is used.
export function subagentModelId(provider: Provider, chatModel: string, choice: SubagentModelChoice): string {
  if (choice === 'same') return chatModel;
  const chosen = choice === 'mid' ? MID_MODELS[provider] : SMALL_MODELS[provider];
  const chosenPrice = MODEL_PRICING[chosen];
  const chatPrice = MODEL_PRICING[chatModel];
  if (chosenPrice && chatPrice && chosenPrice.input + chosenPrice.output > chatPrice.input + chatPrice.output) {
    return chatModel;
  }
  return chosen;
}

export type SubagentEffortChoice = 'match' | 'scaled';

export const DEFAULT_SUBAGENT_EFFORT: SubagentEffortChoice = 'match';

export function effortForSubagent(
  role: 'task' | 'finder' | 'oracle',
  chatEffort: Effort,
  choice: SubagentEffortChoice,
): Effort {
  if (choice === 'match') return chatEffort;
  if (role === 'finder') return 'low';
  if (role === 'task') return 'medium';
  return chatEffort;
}

// US dollars per million tokens at the providers' standard list prices (October 2026). Custom ids get no estimate.
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  longContext?: ModelPricing;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longContext: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-6-astra': {
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
    longContext: { input: 20, output: 75, cacheRead: 2, cacheWrite: 25 },
  },
  'gpt-6.1-sol': {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    longContext: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 },
  },
  'gpt-6-sol': {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    longContext: { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 },
  },
  'gpt-6-luna': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longContext: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
  },
};

// Estimated cost in dollars of a chat's token usage, or null when the model/provider price is not known.
export function estimateCost(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens?: number;
    longContext?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  },
  officialProvider = true,
): number | null {
  if (!officialProvider) return null;
  const price = MODEL_PRICING[model];
  if (!price) return null;
  // Long-context tokens are split out only when the model has a long-context price; otherwise they stay at list price.
  const longPrice = price.longContext;
  const long = longPrice ? usage.longContext : undefined;
  const shortCost =
    (usage.inputTokens - (long?.inputTokens ?? 0)) * price.input +
    (usage.outputTokens - (long?.outputTokens ?? 0)) * price.output +
    (usage.cacheReadTokens - (long?.cacheReadTokens ?? 0)) * price.cacheRead +
    ((usage.cacheWriteTokens ?? 0) - (long?.cacheWriteTokens ?? 0)) * price.cacheWrite;
  const longCost =
    long && longPrice
      ? long.inputTokens * longPrice.input +
        long.outputTokens * longPrice.output +
        long.cacheReadTokens * longPrice.cacheRead +
        long.cacheWriteTokens * longPrice.cacheWrite
      : 0;
  return (shortCost + longCost) / 1_000_000;
}

// Estimated cost in dollars of a whole chat: the usage subagents spent on other models (usage.byModel) at those models'
// rates, and the rest at the chat model's. Null when any part's price is not known, like estimateCost.
export function estimateChatCost(chatModel: string, usage: UsageTotals, officialProvider = true): number | null {
  const own = { ...usage, longContext: usage.longContext ? { ...usage.longContext } : undefined };
  let others = 0;
  for (const [model, part] of Object.entries(usage.byModel ?? {})) {
    const cost = estimateCost(model, part, officialProvider);
    if (cost === null) return null;
    others += cost;
    own.inputTokens -= part.inputTokens;
    own.outputTokens -= part.outputTokens;
    own.cacheReadTokens -= part.cacheReadTokens;
    own.cacheWriteTokens = (own.cacheWriteTokens ?? 0) - (part.cacheWriteTokens ?? 0);
    if (own.longContext && part.longContext) {
      own.longContext.inputTokens -= part.longContext.inputTokens;
      own.longContext.outputTokens -= part.longContext.outputTokens;
      own.longContext.cacheReadTokens -= part.longContext.cacheReadTokens;
      own.longContext.cacheWriteTokens -= part.longContext.cacheWriteTokens;
    }
  }
  const cost = estimateCost(chatModel, own, officialProvider);
  return cost === null ? null : cost + others;
}

export function formatCost(dollars: number): string {
  return dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`;
}

// Semantic code search embeds through OpenRouter with Voyage's code model (1024 dimensions by default).
export const EMBEDDING_MODEL = 'voyageai/voyage-code-4';
export const EMBEDDING_BASE_URL = 'https://openrouter.ai/api/v1';
// Reorders the best embedding matches before search_code returns them, through the same OpenRouter key.
export const RERANK_MODEL = 'voyageai/rerank-3';

// Prompt size (tokens) from which the app suggests compacting the chat. One value for every model: context windows
// differ (and are unknown for custom endpoints), so this is a nudge well below the common 200k, not a limit.
export const COMPACT_SUGGESTED_TOKENS = 150_000;

// Any model id can be entered in settings; ids starting with "claude" go to Anthropic, the rest to the
// OpenAI-compatible endpoint.
export function providerForModel(model: string): Provider {
  return model.toLowerCase().startsWith('claude') ? 'anthropic' : 'openai';
}

export interface ClaudeCapabilities {
  // Adaptive thinking and output_config.effort.
  adaptiveThinking: boolean;
  // Server-side compaction (beta compact-2026-01-12).
  compaction: boolean;
  // Server-side refusal fallback with fallbacks: "default" (beta server-side-fallback-2026-07-01).
  refusalFallback: boolean;
  // Image input: attached or pasted images in a user message.
  images: boolean;
  // Grammar-constrained tool inputs (strict: true).
  strictTools: boolean;
}

// Claude models known to accept images. A custom Claude id is not assumed to, since an image it cannot take is a 400.
const IMAGE_MODELS = /^claude-(opus-5-5|sonnet-5-5|haiku-5-5|haiku-4-5|opus-5|fable-5-1|fable-5)$/;

// Request features differ per Claude model and sending an unsupported one is a 400, so features are enabled
// only for models known to support them. Unknown (custom) Claude ids get a plain request.
const CURRENT_GENERATION = /^claude-(opus-5-5|sonnet-5-5|haiku-5-5|opus-5|fable-5-1|fable-5)$/;

export function claudeCapabilities(model: string): ClaudeCapabilities {
  const current = CURRENT_GENERATION.test(model);
  return {
    adaptiveThinking: current,
    compaction: current,
    refusalFallback: /^claude-(opus-5-5|sonnet-5-5|fable-5-1)$/.test(model),
    images: IMAGE_MODELS.test(model),
    strictTools: current || model === 'claude-haiku-4-5',
  };
}

// Whether a message to this model may carry images. Claude models go by claudeCapabilities. OpenAI models and
// OpenAI-compatible endpoints are allowed as before: the app cannot tell what a custom endpoint's model accepts, and
// it reports the endpoint's own error if it refuses.
export function acceptsImages(model: string): boolean {
  return providerForModel(model) === 'anthropic' ? claudeCapabilities(model).images : true;
}

export function imagesNotSupportedMessage(model: string): string {
  return `${MODEL_OPTIONS.find((option) => option.id === model)?.label ?? model} does not accept images. Remove the attached images, or start a new chat with a model that accepts them.`;
}
