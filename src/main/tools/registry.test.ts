import { describe, expect, it } from 'vitest';
import { availableTools } from './registry';
import type { AgentTool } from './types';

function named(name: string): AgentTool {
  return { name } as AgentTool;
}

describe('availableTools', () => {
  const context = { browser: null, codeSearch: null, webSearch: null };

  it('sorts extra tools by name', () => {
    const extra = [named('zeta_tool'), named('alpha_tool')];
    const names = availableTools(context, extra).map((tool) => tool.name);

    expect(names.slice(-2)).toEqual(['alpha_tool', 'zeta_tool']);
    expect(extra.map((tool) => tool.name)).toEqual(['zeta_tool', 'alpha_tool']);
  });

  // Tools sit before the system prompt in the prompt cache prefix: a list that changed with plan mode would make
  // the next request of a chat miss the cache (#44).
  it('always offers propose_plan, so plan mode never changes the tool list', () => {
    expect(availableTools(context).map((tool) => tool.name)).toContain('propose_plan');
  });
});
