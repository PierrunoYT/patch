/**
 * Lint and test execution adapted from aider/coders/base_coder.py and
 * aider/run_cmd.py at revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to run only explicit user configuration through its
 * bounded Node.js process adapter.
 * Licensed under the Apache License, Version 2.0.
 */

import type {
  ReflectionCheck,
  ReflectionChecks,
} from "../core/coder-session.js";
import {
  executeModelCommand,
  type ModelCommandOptions,
  type ModelCommandResult,
} from "./model-command.js";

export interface ConfiguredCheckCommands {
  readonly lintCommand?: string;
  readonly testCommand?: string;
}

export type ConfiguredCheckOptions = ModelCommandOptions;

function diagnostic(
  label: "lint" | "test",
  result: ModelCommandResult,
): string | undefined {
  if (result.status === "completed" && result.exitCode === 0) return undefined;

  const output = [result.stdout, result.stderr]
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
  const summary =
    result.status === "completed"
      ? `Configured ${label} command exited with code ${String(result.exitCode)}`
      : `Configured ${label} command was ${result.status}`;
  return output === "" ? summary : `${summary}\n\n${output}`;
}

function configuredCheck(
  label: "lint" | "test",
  command: string | undefined,
  options: ConfiguredCheckOptions,
): ReflectionCheck | undefined {
  if (command === undefined) return undefined;

  return async () => {
    const result = await executeModelCommand(command, options, {
      show: () => undefined,
      approve: () => true,
    });
    return diagnostic(label, result);
  };
}

/**
 * Creates session checks only for commands the user explicitly configured.
 * An absent command remains absent; package files are never inspected and no
 * npm, yarn, pnpm, or bun command is inferred.
 */
export function createConfiguredChecks(
  commands: ConfiguredCheckCommands,
  options: ConfiguredCheckOptions,
): ReflectionChecks {
  const lint = configuredCheck("lint", commands.lintCommand, options);
  const test = configuredCheck("test", commands.testCommand, options);
  return {
    ...(lint === undefined ? {} : { lint }),
    ...(test === undefined ? {} : { test }),
  };
}
