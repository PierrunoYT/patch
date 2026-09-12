import type { ModelCommandResult } from "../process/model-command.js";

export interface ApplicationEvent {
  readonly type: string;
  readonly data: unknown;
}

export interface ApplicationSubmitOptions {
  readonly signal: AbortSignal;
  readonly emit: (event: ApplicationEvent) => void;
  /** Suppress all proposed edits and shell commands for question-only input. */
  readonly readOnly?: boolean;
}

export interface ApplicationSession {
  /** The sole mutation queue shared by every adapter using this session. */
  readonly queue?: import("./serial-queue.js").SerialTaskQueue;
  snapshot(): unknown | Promise<unknown>;
  submit(message: string, options: ApplicationSubmitOptions): Promise<unknown>;
  /** Runs an internal fresh-history editor role; not a user-facing chat mode. */
  runEditor?(
    instructions: string,
    options: ApplicationSubmitOptions,
  ): Promise<unknown>;
  close?(): void | Promise<void>;
}

export interface ApplicationService {
  createSession(context: {
    readonly principal: string;
    readonly sessionId: string;
  }): ApplicationSession | Promise<ApplicationSession>;
  close?(): void | Promise<void>;
}

/**
 * Raised when a turn fails or is cancelled after some work reached the
 * worktree. Interfaces can deliberately expose an allowlisted subset instead
 * of either hiding the surviving state or leaking the underlying failure.
 */
export class TurnPartiallyAppliedError extends Error {
  override readonly name = "TurnPartiallyAppliedError";
  readonly changedPaths: readonly string[];
  readonly commit: string | null;
  readonly commands: readonly ModelCommandResult[];

  constructor(
    cause: unknown,
    result: {
      readonly kind?: "turn" | "command";
      readonly changedPaths: readonly string[];
      readonly commit: string | null;
      readonly commands: readonly ModelCommandResult[];
    },
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const survived = [
      result.changedPaths.length === 0
        ? undefined
        : `changed ${result.changedPaths.join(", ")}`,
      result.commit === null ? undefined : `committed ${result.commit}`,
    ].filter((part) => part !== undefined);
    super(`${reason}\nThe turn already ${survived.join(" and ")}.`, { cause });
    this.changedPaths = [...result.changedPaths];
    this.commit = result.commit;
    this.commands = [...result.commands];
  }
}
