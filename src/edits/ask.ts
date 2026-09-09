/**
 * Ported from aider/coders/ask_coder.py and its inherited no-op edit methods at
 * revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch's injected EditStrategy contract.
 */

import type { EditStrategy } from "./strategy.js";
import type { EditStrategyContext } from "./strategy.js";
import type { EditBatch } from "./types.js";

export const ASK_SYSTEM_PROMPT = `Act as an expert code analyst.
Answer questions about the supplied code.
If you need to describe code changes, do so briefly.
Do not return full diffs or claim to have changed files.`;

export class AskEditStrategy implements EditStrategy {
  readonly format = "ask" as const;

  parse(response: string, context: EditStrategyContext): EditBatch {
    void response;
    void context;
    return { edits: [], shellCommands: [] };
  }
}
