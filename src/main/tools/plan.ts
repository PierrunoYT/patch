import { z } from 'zod';
import { defineTool } from './types';

// Added by the app to each user message while plan mode is on, and once when it was turned off again. Mid-run
// toggles are noted in tool results. The latest note stays authoritative across intervening messages and images.
// The tool is always in the tool list, so toggling plan mode changes only message text, never the cached prefix
// (tools sit before the system prompt in Claude's prompt cache).
export const PLAN_MODE_ON_NOTE =
  'Plan mode is on: before changing files or running commands for a multi-step task, call propose_plan and wait for the decision.';
export const PLAN_MODE_OFF_NOTE = 'Plan mode is off now: do not call propose_plan.';

// What a propose_plan call gets when plan mode is off. No approval card is shown and nothing else is held back.
export const PLAN_MODE_OFF_RESULT = 'Plan mode is off, so no plan is needed. Carry on with the task.';

// Plan mode: the model describes what it intends to do, the user approves or declines on an approval card, and the
// decision comes back to the model before any side effect happens. alwaysAsk keeps the card even in Auto mode, so
// turning plan mode on never silently pretends the user approved a plan they did not see. The agent loop runs this
// call before the rest of its batch and skips those other calls until the decision is back.
export const proposePlanTool = defineTool({
  name: 'propose_plan',
  description:
    'Only for plan mode. Use the most recent plan-mode note from the app, whether it appears in a user message or a tool result. That setting remains in effect until a newer plan-mode note changes it; intervening messages and tool images do not change it. If no plan-mode note has been provided, or the latest one says plan mode is off, do not call this. In plan mode: before changing files or running commands for a multi-step task, call this first and wait for the decision. Describe the steps concretely (files, commands, order) and keep the plan short enough to read in a minute. Do not call any other tool in the same response: those calls are not run until the plan is decided, and you should call them again afterwards. A single read or a one-step change does not need a plan.',
  schema: z.object({
    plan: z.string().describe('The plan in markdown: numbered steps, files to change, commands to run.'),
    summary: z.string().describe('One line describing the goal, shown as the card title.'),
  }),
  requiresApproval: true,
  alwaysAsk: true,
  preview: async ({ summary, plan }) => ({ title: summary || 'Plan', text: plan }),
  async run({ summary }) {
    return {
      content:
        'The user approved the plan. Carry it out step by step; if reality differs from the plan, say what changed and why before deviating.',
      summary: `Plan approved: ${summary || '(untitled)'}`,
    };
  },
});
