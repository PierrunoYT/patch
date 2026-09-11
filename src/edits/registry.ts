import { ASK_SYSTEM_PROMPT, AskEditStrategy } from "./ask.js";
import { PatchEditStrategy } from "./patch.js";
import {
  FencedSearchReplaceEditStrategy,
  SearchReplaceEditStrategy,
} from "./search-replace.js";
import type { EditStrategy } from "./strategy.js";
import type { EditFormat } from "./types.js";
import { UnifiedDiffEditStrategy } from "./unified-diff.js";
import { WholeFileEditStrategy } from "./whole-file.js";
import type { Fence } from "../core/fences.js";
import type { ChatMessage } from "../core/messages.js";
import { fencedSearchReplaceReminder } from "../resources/prompts.js";

export interface StrategyDefinition {
  readonly strategy: EditStrategy;
  readonly systemPrompt: string;
  readonly examples: readonly ChatMessage[];
  readonly reminder: string;
  readonly allowShellCommands: boolean;
}

export class UnsupportedEditFormatError extends Error {
  override readonly name = "UnsupportedEditFormatError";

  constructor(format: EditFormat) {
    super(`Edit format is not available through the application: ${format}`);
  }
}

const editingRole = `Act as an expert software engineer. Make only the requested changes.
Return edits using exactly the required format. Never omit unchanged context needed to apply an edit.`;

const DEFAULT_FENCE: Fence = ["```", "```"];

function searchReplaceExample(fence: Fence, filenameInside: boolean): string {
  const filename = "src/value.ts";
  const block = `${fence[0]}ts\n${
    filenameInside ? `${filename}\n` : ""
  }<<<<<<< SEARCH\nexport const value = 1;\n=======\nexport const value = 2;\n>>>>>>> REPLACE\n${fence[1]}`;
  return filenameInside ? block : `${filename}\n${block}`;
}

export function createStrategy(
  format: EditFormat,
  fence: Fence = DEFAULT_FENCE,
): StrategyDefinition {
  switch (format) {
    case "ask":
      return {
        strategy: new AskEditStrategy(),
        systemPrompt: ASK_SYSTEM_PROMPT,
        examples: [],
        reminder:
          "Answer the user's question without proposing executable edits.",
        allowShellCommands: false,
      };
    case "whole":
      return {
        strategy: new WholeFileEditStrategy(),
        systemPrompt: `${editingRole}\nReturn each changed file as its path followed by a complete fenced file body.`,
        examples: [
          { role: "user", content: "Change src/value.ts." },
          {
            role: "assistant",
            content: "src/value.ts\n```ts\nexport const value = 2;\n```",
          },
        ],
        reminder: "Return the complete contents of every changed file.",
        allowShellCommands: false,
      };
    case "diff":
      return {
        strategy: new SearchReplaceEditStrategy(),
        systemPrompt: `${editingRole}\nUse filename-labelled <<<<<<< SEARCH, =======, >>>>>>> REPLACE blocks.`,
        examples: [
          { role: "user", content: "Change the value from 1 to 2." },
          {
            role: "assistant",
            content: searchReplaceExample(fence, false),
          },
        ],
        reminder:
          "SEARCH text must match exactly once. Include the filename before every edit block.",
        allowShellCommands: true,
      };
    case "diff-fenced":
      return {
        strategy: new FencedSearchReplaceEditStrategy(),
        systemPrompt: `${editingRole}\nUse fenced <<<<<<< SEARCH, =======, >>>>>>> REPLACE blocks with the full filename inside each fence, immediately after the opening fence and language.`,
        examples: [
          { role: "user", content: "Change the value from 1 to 2." },
          {
            role: "assistant",
            content: searchReplaceExample(fence, true),
          },
        ],
        reminder: fencedSearchReplaceReminder(fence),
        allowShellCommands: true,
      };
    case "udiff":
      return {
        strategy: new UnifiedDiffEditStrategy(),
        systemPrompt: `${editingRole}\nReturn standard unified diffs in fenced diff blocks.`,
        examples: [],
        reminder: "Include ---/+++ paths and enough exact hunk context.",
        allowShellCommands: false,
      };
    case "patch":
      return {
        strategy: new PatchEditStrategy(),
        systemPrompt: `${editingRole}\nReturn one *** Begin Patch / *** End Patch patch.`,
        examples: [],
        reminder:
          "Use Add File, Delete File, or Update File headers with repository-relative paths.",
        allowShellCommands: false,
      };
    default:
      throw new UnsupportedEditFormatError(format);
  }
}
