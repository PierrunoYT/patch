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
  close?(): void | Promise<void>;
}

export interface ApplicationService {
  createSession(context: {
    readonly principal: string;
    readonly sessionId: string;
  }): ApplicationSession | Promise<ApplicationSession>;
  close?(): void | Promise<void>;
}
