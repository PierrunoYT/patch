import { describe, expect, it } from 'vitest';
import { availableTools } from './registry';
import { rememberTool } from './remember';
import type { ToolContext } from './types';

describe('remember tool', () => {
  it('always asks, so Auto mode cannot save a note unseen', () => {
    expect(rememberTool.alwaysAsk).toBe(true);
    expect(rememberTool.requiresApproval).toBe(true);
  });

  it('shows the exact note on the approval card', async () => {
    const input = rememberTool.schema!.parse({ note: 'Use pnpm, not npm', why: 'The lockfile is pnpm-lock.yaml' });
    const preview = await rememberTool.preview!(input, {} as never);
    expect(preview.text).toContain('Use pnpm, not npm');
    expect(preview.text).toContain('pnpm-lock.yaml');
  });

  it('saves only the note, after approval, and reports refusals as errors', async () => {
    const saved: string[] = [];
    const context = { remember: (note: string) => (saved.push(note), 'saved') } as unknown as ToolContext;
    const output = await rememberTool.run({ note: ' Use pnpm ', why: 'x' }, context);
    expect(saved).toEqual([' Use pnpm ']);
    expect(output.summary).toBe('Remembered: Use pnpm');

    for (const outcome of ['off', 'duplicate', 'full', 'empty'] as const) {
      await expect(
        rememberTool.run({ note: 'a', why: 'b' }, { remember: () => outcome } as unknown as ToolContext),
      ).rejects.toThrow();
    }
    await expect(rememberTool.run({ note: 'a', why: 'b' }, {} as never)).rejects.toThrow(/no project memory/);
  });

  it('is offered only when the chat has a memory section', () => {
    const context = { browser: null, codeSearch: null, webSearch: null };
    expect(availableTools(context).map((tool) => tool.name)).not.toContain('remember');
    expect(availableTools(context, [], { memory: true }).map((tool) => tool.name)).toContain('remember');
  });
});
