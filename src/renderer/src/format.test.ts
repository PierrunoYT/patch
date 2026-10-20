import { describe, expect, it } from 'vitest';
import { estimateTokens, formatDuration, formatTokens, modelGroup } from './format';

describe('display formats', () => {
  it('shortens token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(12_540)).toBe('12.5k');
    expect(formatTokens(48_000)).toBe('48k');
    expect(formatTokens(142_400)).toBe('142k');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_050_000)).toBe('1.05M');
  });

  it('shows durations', () => {
    expect(formatDuration(140)).toBe('140ms');
    expect(formatDuration(2400)).toBe('2.4s');
    expect(formatDuration(3000)).toBe('3s');
    expect(formatDuration(65_000)).toBe('1m 05s');
  });

  it('estimates tokens from characters', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('modelGroup', () => {
  it('puts Claude Code models in their own group, not in Claude', () => {
    expect(modelGroup('claude-opus-5-5')).toBe('Claude');
    expect(modelGroup('claude-code/claude-opus-5-5')).toBe('Claude Code');
    expect(modelGroup('gpt-5')).toBe('OpenAI');
    expect(modelGroup('custom-model')).toBe('Other');
  });
});
