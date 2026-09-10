/**
 * Ported from aider/coders/architect_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to make acceptance and both provider sessions explicit contracts.
 * Licensed under the Apache License, Version 2.0.
 */

import type {
  CompletedTurn,
  CoderSession,
  RunTurnOptions,
} from "./coder-session.js";

export interface ArchitectAcceptanceRequest {
  readonly plan: string;
}

export interface ArchitectHandoffOptions {
  readonly signal?: AbortSignal;
  readonly architect?: Omit<RunTurnOptions, "signal">;
  readonly editor?: Omit<RunTurnOptions, "signal">;
  readonly accept: (
    request: ArchitectAcceptanceRequest,
  ) => boolean | Promise<boolean>;
}

export interface ArchitectHandoffResult {
  readonly plan: CompletedTurn;
  readonly accepted: boolean;
  readonly editor?: CompletedTurn;
}

export class ArchitectOrchestrator {
  readonly #architect: CoderSession;
  readonly #editor: CoderSession;

  constructor(architect: CoderSession, editor: CoderSession) {
    if (architect.strategy.format !== "architect") {
      throw new Error("Architect session must use the architect format");
    }
    if (
      editor.strategy.format === "architect" ||
      editor.strategy.format === "ask"
    ) {
      throw new Error("Editor session must use an editing format");
    }
    this.#architect = architect;
    this.#editor = editor;
  }

  async run(
    userInput: string,
    options: ArchitectHandoffOptions,
  ): Promise<ArchitectHandoffResult> {
    const plan = await this.#architect.runTurn(userInput, {
      ...options.architect,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (
      plan.response.trim() === "" ||
      !(await options.accept({ plan: plan.response }))
    ) {
      return { plan, accepted: false };
    }
    if (options.signal?.aborted) throw options.signal.reason;
    const editor = await this.#editor.runTurn(plan.response, {
      ...options.editor,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return { plan, accepted: true, editor };
  }
}
