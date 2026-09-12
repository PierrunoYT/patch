/**
 * Slash-command behavior ported from aider/commands.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to return inert, validated effects instead of mutating a coder.
 * Licensed under the Apache License, Version 2.0.
 */

import { ApplicationEditFormatSchema } from "../edits/types.js";
import { CommandEffectSchema, type CommandEffect } from "./effects.js";

export class CommandParseError extends Error {
  override readonly name = "CommandParseError";
}

/**
 * Every command `parseCommand` accepts, for completion and help. Kept in sync by
 * a test that parses each name, so an added command cannot stay uncompletable.
 */
export const COMMAND_NAMES: readonly string[] = [
  "add",
  "attach",
  "chat-mode",
  "clear",
  "commit",
  "copy",
  "drop",
  "exit",
  "help",
  "lint",
  "ls",
  "model",
  "paste",
  "read-only",
  "run",
  "settings",
  "test",
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

function parsePaths(
  command: string,
  argument: string,
  required: boolean,
): string[] {
  const paths: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const finish = () => {
    if (current !== "") paths.push(current);
    current = "";
  };

  for (const character of argument) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      finish();
    } else {
      current += character;
    }
  }
  if (escaped || quote !== undefined) {
    throw new CommandParseError(`/${command} has an unterminated quoted path`);
  }
  finish();
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
    case "web":
      // One URL, typed by the user: a whitespace-separated list would make it
      // easy to fetch more than was intended.
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
