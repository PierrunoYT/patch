/**
 * Slash-command behavior ported from aider/commands.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to return inert, validated effects instead of mutating a coder.
 * Licensed under the Apache License, Version 2.0.
 */

import { ApplicationEditFormatSchema } from "../edits/types.js";
import {
  splitQuotedWords,
  UnterminatedWordQuoteError,
} from "../io/word-split.js";
import { CommandEffectSchema, type CommandEffect } from "./effects.js";

export class CommandParseError extends Error {
  override readonly name = "CommandParseError";
}

/**
 * Every command `parseCommand` accepts, for completion and help. A test compares
 * this list against the parser's own switch in both directions, so a command
 * added to one and not the other fails rather than staying uncompletable.
 */
export const COMMAND_NAMES: readonly string[] = [
  "add",
  "attach",
  "chat-mode",
  "clear",
  "commit",
  "copy",
  "diff",
  "drop",
  "exit",
  "help",
  "lint",
  "ls",
  "map",
  "model",
  "models",
  "weak-model",
  "editor-model",
  "reasoning-effort",
  "think-tokens",
  "paste",
  "read-only",
  "report",
  "run",
  "settings",
  "test",
  "tokens",
  "undo",
  "web",
];

function requireArgument(command: string, argument: string): string {
  if (argument === "") {
    throw new CommandParseError(`/${command} requires an argument`);
  }
  return argument;
}

function rejectArgument(command: string, argument: string): void {
  if (argument !== "") {
    throw new CommandParseError(`/${command} does not accept arguments`);
  }
}

function optionalHelpQuery(argument: string): string | undefined {
  if (argument === "") return undefined;
  if (argument.length > 256 || /[\p{Cc}\p{Cf}]/u.test(argument)) {
    throw new CommandParseError(
      "/help query must be at most 256 characters without control characters",
    );
  }
  return argument;
}

function optionalModelQuery(argument: string): string | undefined {
  if (argument === "") return undefined;
  if (argument.length > 256 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(argument)) {
    throw new CommandParseError(
      "/models query must be at most 256 characters without control characters",
    );
  }
  return argument;
}

function optionalReportTitle(argument: string): string | undefined {
  if (argument === "") return undefined;
  if (argument.length > 160 || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(argument)) {
    throw new CommandParseError(
      "/report title must be at most 160 characters without control characters",
    );
  }
  return argument;
}

function parsePaths(
  command: string,
  argument: string,
  required: boolean,
): string[] {
  let paths: string[];
  try {
    paths = splitQuotedWords(argument);
  } catch (error) {
    if (!(error instanceof UnterminatedWordQuoteError)) throw error;
    throw new CommandParseError(`/${command} has an unterminated quoted path`);
  }
  if (required && paths.length === 0) {
    throw new CommandParseError(`/${command} requires at least one path`);
  }
  return paths;
}

export function parseCommand(input: string): CommandEffect {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return CommandEffectSchema.parse({ type: "submit", message: input });
  }

  const match = /^\/(\S+)(?:\s+(.*))?$/su.exec(trimmed);
  if (match === null) {
    throw new CommandParseError("A slash command requires a name");
  }
  const command = match[1]?.toLowerCase() ?? "";
  const argument = match[2]?.trim() ?? "";
  let effect: unknown;
  switch (command) {
    case "add":
    case "attach":
    case "read-only":
      effect = { type: command, paths: parsePaths(command, argument, true) };
      break;
    case "drop":
      effect = { type: "drop", paths: parsePaths(command, argument, false) };
      break;
    case "help": {
      const query = optionalHelpQuery(argument);
      effect = { type: "help", ...(query === undefined ? {} : { query }) };
      break;
    }
    case "report": {
      const title = optionalReportTitle(argument);
      effect = { type: "report", ...(title === undefined ? {} : { title }) };
      break;
    }
    case "diff":
    case "tokens":
    case "map":
    case "ls":
    case "clear":
    case "settings":
    case "test":
    case "lint":
    case "undo":
    case "copy":
    case "paste":
      rejectArgument(command, argument);
      effect = {
        type:
          command === "copy"
            ? "clipboard-copy"
            : command === "paste"
              ? "clipboard-paste"
              : command,
      };
      break;
    case "model":
      effect = { type: "model", model: requireArgument(command, argument) };
      break;
    case "weak-model":
      {
        const model = optionalModelQuery(argument);
        effect = {
          type: "weak-model",
          ...(model === undefined ? {} : { model }),
        };
      }
      break;
    case "editor-model":
      {
        const model = optionalModelQuery(argument);
        effect = {
          type: "editor-model",
          ...(model === undefined ? {} : { model }),
        };
      }
      break;
    case "models": {
      const query = optionalModelQuery(argument);
      effect = { type: "models", ...(query === undefined ? {} : { query }) };
      break;
    }
    case "reasoning-effort": {
      if (argument === "") effect = { type: "reasoning-effort" };
      else if (["low", "medium", "high", "off"].includes(argument))
        effect = {
          type: "reasoning-effort",
          effort: argument as "low" | "medium" | "high" | "off",
        };
      else
        throw new CommandParseError(
          "/reasoning-effort accepts low, medium, high, or off",
        );
      break;
    }
    case "think-tokens": {
      if (argument === "") effect = { type: "think-tokens" };
      else if (/^(?:0|[1-9]\d{0,6})$/u.test(argument)) {
        const tokens = Number(argument);
        if (tokens !== 0 && (tokens < 1024 || tokens > 1_000_000))
          throw new CommandParseError(
            "/think-tokens must be 0 or from 1024 through 1000000",
          );
        effect = { type: "think-tokens", tokens };
      } else
        throw new CommandParseError(
          "/think-tokens accepts 0 or an integer token budget",
        );
      break;
    }
    case "web":
      // One bounded URL, typed by the user: accepting arbitrary length or a
      // whitespace-separated list would widen network intent and memory use.
      if (argument.length > 4096) {
        throw new CommandParseError("/web URL must be at most 4096 characters");
      }
      effect = { type: "web", url: requireArgument(command, argument) };
      break;
    case "chat-mode": {
      const mode = requireArgument(command, argument);
      if (
        mode !== "code" &&
        !ApplicationEditFormatSchema.safeParse(mode).success
      ) {
        throw new CommandParseError(`Unknown chat mode: ${mode}`);
      }
      effect = { type: "chat-mode", mode };
      break;
    }
    case "run": {
      // Upstream picks a PTY from the environment; Patch requires the user to
      // ask for one. `--` ends the flag so a command may start with a dash.
      const flag = /^(--interactive|--)(?:\s+(.*))?$/su.exec(argument);
      effect = {
        type: "run",
        command: requireArgument(
          command,
          flag === null ? argument : (flag[2] ?? "").trim(),
        ),
        ...(flag?.[1] === "--interactive" ? { interactive: true } : {}),
      };
      break;
    }
    case "commit":
      effect = {
        type: "commit",
        ...(argument === "" ? {} : { message: argument }),
      };
      break;
    case "exit":
      rejectArgument(command, argument);
      effect = { type: "exit", code: 0 };
      break;
    default:
      throw new CommandParseError(`Unknown command: /${command}`);
  }
  return CommandEffectSchema.parse(effect);
}
