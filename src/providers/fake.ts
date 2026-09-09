import { z } from "zod";

import {
  CompletionEventSchema,
  CompletionRequestSchema,
  type CompletionEvent,
  type CompletionRequest,
  type ModelProvider,
} from "./events.js";

const DelayActionSchema = z
  .object({
    type: z.literal("delay"),
    milliseconds: z.number().int().nonnegative(),
  })
  .strict();

export const FakeProviderActionSchema = z.union([
  CompletionEventSchema,
  DelayActionSchema,
]);

export const FakeProviderTurnSchema = z
  .object({
    actions: z.array(FakeProviderActionSchema),
  })
  .strict();

export const FakeProviderScriptSchema = z.array(FakeProviderTurnSchema);

export type FakeProviderAction = z.infer<typeof FakeProviderActionSchema>;
export type FakeProviderTurn = z.infer<typeof FakeProviderTurnSchema>;

async function wait(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }

  return new Promise((resolve) => {
    const onAbort = () => finish(false);
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(completed);
    };

    const timer = setTimeout(() => finish(true), milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeProvider implements ModelProvider {
  readonly #turns: FakeProviderTurn[];
  readonly #requests: CompletionRequest[] = [];
  #nextTurn = 0;

  constructor(script: unknown) {
    this.#turns = FakeProviderScriptSchema.parse(script);
  }

  get requests(): readonly CompletionRequest[] {
    return this.#requests;
  }

  get remainingTurns(): number {
    return this.#turns.length - this.#nextTurn;
  }

  async *stream(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<CompletionEvent> {
    const validatedRequest = CompletionRequestSchema.parse(request);
    const turn = this.#turns[this.#nextTurn];
    if (turn === undefined) {
      throw new Error(
        `No fake provider turn scripted for request ${this.#nextTurn + 1}`,
      );
    }

    this.#requests.push(validatedRequest);
    this.#nextTurn += 1;

    for (const action of turn.actions) {
      if (signal?.aborted) {
        yield { type: "finish", reason: "cancelled" };
        return;
      }

      if (action.type === "delay") {
        if (!(await wait(action.milliseconds, signal))) {
          yield { type: "finish", reason: "cancelled" };
          return;
        }
        continue;
      }

      yield action;
    }
  }
}
