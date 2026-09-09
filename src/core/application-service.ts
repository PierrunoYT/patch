export interface ApplicationEvent {
  readonly type: string;
  readonly data: unknown;
}

export interface ApplicationSubmitOptions {
  readonly signal: AbortSignal;
  readonly emit: (event: ApplicationEvent) => void;
}

export interface ApplicationSession {
  snapshot(): unknown | Promise<unknown>;
  submit(message: string, options: ApplicationSubmitOptions): Promise<unknown>;
  close?(): void | Promise<void>;
}

export interface ApplicationService {
  createSession(context: {
    readonly principal: string;
    readonly sessionId: string;
  }): ApplicationSession | Promise<ApplicationSession>;
}
