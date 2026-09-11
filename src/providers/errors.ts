/**
 * Transient-failure classification adapted from aider/exceptions.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch: classification is shared by the provider adapters and keyed
 * on HTTP status rather than a table of LiteLLM exception classes.
 * Licensed under the Apache License, Version 2.0.
 */

import { z } from "zod";

import type { CompletionEvent } from "./events.js";

type ErrorEvent = Extract<CompletionEvent, { type: "error" }>;
type ErrorKind = ErrorEvent["kind"];

/**
 * Classifies a status the SDK's own error classes do not already cover.
 *
 * A server-side failure is worth another attempt; a request the server rejected
 * as malformed is not, because repeating it produces the same rejection.
 */
export function transientByStatus(
  status: number | undefined,
): { kind: ErrorKind; retryable: boolean } | undefined {
  if (status === undefined) return undefined;
  if (status === 408) return { kind: "timeout", retryable: true };
  if (status === 429) return { kind: "rate-limit", retryable: true };
  // 409 is a transient conflict; 5xx covers internal, bad-gateway,
  // service-unavailable, and the 529 overload some providers return.
  if (status === 409 || (status >= 500 && status <= 599)) {
    return { kind: "provider", retryable: true };
  }
  return undefined;
}

/**
 * A chunk that fails schema validation usually means a truncated or garbled
 * response rather than a permanent contract change, so the attempt is repeated
 * instead of failing the turn outright.
 */
export function responseValidationEvent(
  error: unknown,
): ErrorEvent | undefined {
  if (!(error instanceof z.ZodError)) return undefined;
  return {
    type: "error",
    kind: "provider",
    message: `The provider returned a response Patch could not read: ${error.message}`,
    retryable: true,
  };
}
