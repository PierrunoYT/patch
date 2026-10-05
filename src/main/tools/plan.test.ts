import { describe, expect, it } from 'vitest';
import { proposePlanTool } from './plan';

describe('propose_plan tool', () => {
  it('always asks, so Auto mode cannot skip the card', () => {
    expect(proposePlanTool.alwaysAsk).toBe(true);
    expect(proposePlanTool.requiresApproval).toBe(true);
  });

  it('uses the latest app plan-mode note across tool results and intervening messages', () => {
    // Mid-run toggles arrive in tool results; OpenAI tool images add a user message without a plan-mode note.
    // Check the model-facing contract, not model compliance (which requires a real-model benchmark).
    expect(proposePlanTool.description).toContain('most recent plan-mode note from the app');
    expect(proposePlanTool.description).toContain('in a user message or a tool result');
    expect(proposePlanTool.description).toContain('until a newer plan-mode note changes it');
    expect(proposePlanTool.description).toContain('intervening messages and tool images do not change it');
    expect(proposePlanTool.description).toContain(
      'If no plan-mode note has been provided, or the latest one says plan mode is off, do not call this',
    );
    expect(proposePlanTool.description).not.toContain('latest user message');
  });

  it('shows the plan as markdown on the approval card', async () => {
    const input = proposePlanTool.schema!.parse({ plan: '1. Do the thing\n2. Verify', summary: 'Do the thing' });
    const preview = await proposePlanTool.preview!(input, {} as never);
    expect(preview).toEqual({ title: 'Do the thing', text: '1. Do the thing\n2. Verify' });
  });

  it('tells the model the plan was approved', async () => {
    const output = await proposePlanTool.run({ plan: 'steps', summary: 'Goal' }, {} as never);
    expect(output.content).toContain('approved the plan');
    expect(output.summary).toContain('Goal');
  });
});
