import { ArchitectEditStrategy, AskEditStrategy } from "./ask.js";
import { PatchEditStrategy } from "./patch.js";
import {
  FencedSearchReplaceEditStrategy,
  SearchReplaceEditStrategy,
} from "./search-replace.js";
import type { EditStrategy } from "./strategy.js";
import {
  ApplicationEditFormatSchema,
  type ApplicationEditFormat,
} from "./types.js";
import { UnifiedDiffEditStrategy } from "./unified-diff.js";
import { WholeFileEditStrategy } from "./whole-file.js";
import type { Fence } from "../core/fences.js";
import type { ChatMessage } from "../core/messages.js";
import {
  editorStrategyPrompt,
  ARCHITECT_SYSTEM_PROMPT,
  strategyPrompt,
} from "../resources/strategy-prompts.js";

export interface StrategyDefinition {
  readonly format: ApplicationEditFormat;
  readonly strategy: EditStrategy;
  readonly systemPrompt: string;
  readonly examples: readonly ChatMessage[];
  readonly reminder: string;
  readonly allowShellCommands: boolean;
}

export class UnsupportedEditFormatError extends Error {
  override readonly name = "UnsupportedEditFormatError";

  constructor(format: unknown) {
    super(`Edit format is not available through the application: ${format}`);
  }
}

const DEFAULT_FENCE: Fence = ["```", "```"];

export function createStrategy(
  format: unknown,
  fence: Fence = DEFAULT_FENCE,
): StrategyDefinition {
  const supported = ApplicationEditFormatSchema.safeParse(format);
  if (!supported.success) throw new UnsupportedEditFormatError(format);
  const prompts = strategyPrompt(supported.data, fence);
  let strategy: EditStrategy;
  switch (supported.data) {
    case "ask":
      strategy = new AskEditStrategy();
      break;
    case "whole":
      strategy = new WholeFileEditStrategy();
      break;
    case "diff":
      strategy = new SearchReplaceEditStrategy();
      break;
    case "diff-fenced":
      strategy = new FencedSearchReplaceEditStrategy();
      break;
    case "udiff":
      strategy = new UnifiedDiffEditStrategy();
      break;
    case "patch":
      strategy = new PatchEditStrategy();
      break;
    default:
      throw new UnsupportedEditFormatError(format);
  }
  return { format: supported.data, strategy, ...prompts };
}

export function createEditorStrategy(
  format: unknown,
  fence: Fence = DEFAULT_FENCE,
): StrategyDefinition {
  if (format !== "whole" && format !== "diff" && format !== "diff-fenced") {
    throw new UnsupportedEditFormatError(format);
  }
  const definition = createStrategy(format, fence);
  return { ...definition, ...editorStrategyPrompt(format, fence) };
}

export function createArchitectStrategy(): StrategyDefinition {
  return {
    format: "ask",
    strategy: new ArchitectEditStrategy(),
    systemPrompt: ARCHITECT_SYSTEM_PROMPT,
    examples: [],
    reminder: "",
    allowShellCommands: false,
  };
}
