/**
 * Ported from aider/coders/context_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to return a bounded, side-effect-free selection result.
 * Licensed under the Apache License, Version 2.0.
 */

import type { CoderSession, RunTurnOptions } from "./coder-session.js";
import { findFileMentions } from "./file-mentions.js";

export interface ContextSelectionOptions {
  readonly candidates: readonly string[];
  readonly initialPaths?: readonly string[];
  readonly maxIterations?: number;
  readonly signal?: AbortSignal;
  readonly turn?: Omit<RunTurnOptions, "signal">;
}

export interface ContextSelectionResult {
  readonly paths: readonly string[];
  readonly iterations: number;
  readonly converged: boolean;
}

export class ContextSelectionConvergenceError extends Error {
  override readonly name = "ContextSelectionConvergenceError";
  readonly iterations: number;

  constructor(iterations: number) {
    super(
      `Context selection did not converge after ${String(iterations)} iterations`,
    );
    this.iterations = iterations;
  }
}

export async function selectContextFiles(
  session: CoderSession,
  userInput: string,
  options: ContextSelectionOptions,
): Promise<ContextSelectionResult> {
  if (session.strategy.format !== "context")
    throw new Error("Context selection requires a context session");
  const maximum = options.maxIterations ?? 3;
  if (!Number.isInteger(maximum) || maximum < 1)
    throw new RangeError("maxIterations must be a positive integer");
  let paths = [...(options.initialPaths ?? [])];
  for (let iteration = 1; iteration <= maximum; iteration += 1) {
    const message =
      iteration === 1
        ? userInput
        : `Review the file selection for the original request. Current selection: ${paths.join(", ") || "(none)"}. Return the complete file list again.`;
    const result = await session.runTurn(message, {
      ...options.turn,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const selected = findFileMentions(result.response, options.candidates, []);
    if (
      selected.length === paths.length &&
      selected.every((path) => paths.includes(path))
    ) {
      return { paths, iterations: iteration, converged: true };
    }
    paths = selected;
  }
  return { paths, iterations: maximum, converged: false };
}
