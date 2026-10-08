import { describe, expect, it } from 'vitest';
import {
  acceptsImages,
  claudeCapabilities,
  contextWindow,
  DEFAULT_SUBAGENT_EFFORT,
  DEFAULT_SUBAGENT_MODEL,
  effortForSubagent,
  estimateCost,
  formatCost,
  imagesNotSupportedMessage,
  MID_MODELS,
  MODEL_OPTIONS,
  SMALL_MODELS,
  subagentModelId,
} from './models';

describe('current model catalog', () => {
  it('includes the verified models and retains older saved-chat choices', () => {
    for (const id of ['claude-haiku-5-5', 'claude-fable-5-1']) expect(contextWindow(id)).toBe(1_000_000);
    expect(contextWindow('gpt-6.1-sol')).toBe(1_050_000);
    expect(contextWindow('claude-haiku-4-5')).toBe(200_000);
    expect(contextWindow('gpt-6-sol')).toBe(1_050_000);
    expect(SMALL_MODELS.anthropic).toBe('claude-haiku-5-5');
    expect(claudeCapabilities('claude-haiku-5-5')).toEqual({
      adaptiveThinking: true,
      compaction: true,
      refusalFallback: false,
      images: true,
      strictTools: true,
    });
  });
});

describe('strict tool inputs', () => {
  it('is enabled for built-in Claude models and disabled for unknown ids', () => {
    for (const option of MODEL_OPTIONS.filter((option) => option.provider === 'anthropic')) {
      expect(claudeCapabilities(option.id).strictTools).toBe(true);
    }
    for (const model of ['claude-custom', 'claude-2.1', 'claude-opus-5-5-preview']) {
      expect(claudeCapabilities(model).strictTools).toBe(false);
    }
  });
});

describe('image input', () => {
  it('is on for every built-in model', () => {
    for (const option of MODEL_OPTIONS) expect(acceptsImages(option.id)).toBe(true);
  });

  it('is part of claudeCapabilities, and off for Claude ids that are not known to accept images', () => {
    expect(claudeCapabilities('claude-haiku-4-5').images).toBe(true);
    expect(claudeCapabilities('claude-opus-5').images).toBe(true);
    for (const id of ['claude-custom', 'claude-2.1', 'claude-opus-5-5-preview']) {
      expect(claudeCapabilities(id).images).toBe(false);
      expect(acceptsImages(id)).toBe(false);
    }
  });

  it('stays allowed for OpenAI and OpenAI-compatible model ids, whose support the app cannot know', () => {
    expect(acceptsImages('llama3.2')).toBe(true);
    expect(acceptsImages('gpt-6-luna')).toBe(true);
  });

  it('explains the refusal with the model name', () => {
    expect(imagesNotSupportedMessage('claude-custom')).toMatch(/^claude-custom does not accept images\./);
  });
});

describe('estimateCost', () => {
  it('adds input, output and cached input at the model prices', () => {
    // Asymmetric categories catch accidentally treating cache writes as ordinary input or cache reads.
    expect(
      estimateCost('claude-opus-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 3_000_000,
      }),
    ).toBeCloseTo(29.4);
  });

  it('prices Sonnet 5.5 cache reads at 5% of input', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 3_000_000,
    };
    expect(estimateCost('claude-sonnet-5-5', usage)).toBeCloseTo(14.7);
  });

  it('prices mixed GPT-6 short and long requests without choosing a tier from chat totals', () => {
    const usage = {
      inputTokens: 300_000,
      outputTokens: 30_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 20_000,
      // Only one request was long; the other short requests make the aggregate input misleading.
      longContext: { inputTokens: 200_000, outputTokens: 10_000, cacheReadTokens: 80_000, cacheWriteTokens: 5_000 },
    };
    expect(estimateCost('gpt-6-sol', usage)).toBeCloseTo(1.4485);
    expect(estimateCost('gpt-6.1-sol', usage)).toBeCloseTo(1.4305);
  });

  it('prices Haiku mixed request tiers and Fable caching at verified rates', () => {
    expect(
      estimateCost('claude-haiku-5-5', {
        inputTokens: 300_000,
        outputTokens: 30_000,
        cacheReadTokens: 100_000,
        cacheWriteTokens: 20_000,
        longContext: { inputTokens: 200_000, outputTokens: 10_000, cacheReadTokens: 80_000, cacheWriteTokens: 5_000 },
      }),
    ).toBeCloseTo(0.1542);
    expect(
      estimateCost('claude-fable-5-1', {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 100_000,
      }),
    ).toBeCloseTo(16.75);
  });

  it('returns null for unknown models and official ids on custom compatible providers', () => {
    expect(
      estimateCost('gpt-6-astra', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 }, false),
    ).toBeNull();
    expect(estimateCost('claude-custom', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 })).toBeNull();
  });

  it('keeps long-context tokens at list price for models without a long-context price', () => {
    const long = { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(
      estimateCost('claude-haiku-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        longContext: long,
      }),
    ).toBe(1);
  });

  it('accepts legacy usage without cache-write or long-context fields', () => {
    expect(estimateCost('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 })).toBe(1);
  });
});

describe('formatCost', () => {
  it('shows cents, and a floor for tiny amounts', () => {
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});

describe('subagent model and effort', () => {
  it('keeps the chat model on the same provider until the setting changes', () => {
    expect(DEFAULT_SUBAGENT_MODEL).toBe('same');
    expect(MID_MODELS).toEqual({ anthropic: 'claude-sonnet-5-5', openai: 'gpt-6.1-sol' });
    expect(subagentModelId('anthropic', 'claude-custom', 'same')).toBe('claude-custom');
    expect(subagentModelId('openai', 'local-model', 'same')).toBe('local-model');
    expect(subagentModelId('anthropic', 'claude-opus-5-5', 'mid')).toBe(MID_MODELS.anthropic);
    expect(subagentModelId('openai', 'gpt-6-astra', 'mid')).toBe(MID_MODELS.openai);
    expect(subagentModelId('anthropic', 'claude-opus-5-5', 'small')).toBe(SMALL_MODELS.anthropic);
    expect(subagentModelId('openai', 'gpt-6-astra', 'small')).toBe(SMALL_MODELS.openai);
  });

  it('never moves task to a model that costs more than the chat', () => {
    // A chat on the small model keeps it rather than "saving" by moving up to the mid-size model.
    expect(subagentModelId('anthropic', SMALL_MODELS.anthropic, 'mid')).toBe(SMALL_MODELS.anthropic);
    expect(subagentModelId('openai', SMALL_MODELS.openai, 'mid')).toBe(SMALL_MODELS.openai);
    expect(subagentModelId('anthropic', MID_MODELS.anthropic, 'mid')).toBe(MID_MODELS.anthropic);
  });

  it('matches the chat effort, or lowers finder and task while oracle stays', () => {
    expect(DEFAULT_SUBAGENT_EFFORT).toBe('match');
    for (const role of ['task', 'finder', 'oracle'] as const) {
      expect(effortForSubagent(role, 'xhigh', 'match')).toBe('xhigh');
    }
    expect(effortForSubagent('finder', 'max', 'scaled')).toBe('low');
    expect(effortForSubagent('task', 'max', 'scaled')).toBe('medium');
    expect(effortForSubagent('oracle', 'max', 'scaled')).toBe('max');
    expect(effortForSubagent('oracle', 'low', 'scaled')).toBe('low');
  });
});
