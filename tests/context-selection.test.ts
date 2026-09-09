import { describe, expect, it } from "vitest";

import {
  CoderSession,
  ContextEditStrategy,
  FakeProvider,
  selectContextFiles,
  TurnCancelledError,
} from "../src/index.js";

const config = {
  root: "/repo",
  model: { name: "fake", provider: "fake", editFormat: "context" as const },
};
const turn = (text: string) => ({
  actions: [
    { type: "text-delta" as const, text },
    { type: "finish" as const, reason: "stop" as const },
  ],
});

describe("selectContextFiles", () => {
  it("repeats until the complete selected set converges", async () => {
    const provider = new FakeProvider([
      turn("src/a.ts"),
      turn("src/a.ts and src/b.ts"),
      turn("src/b.ts, src/a.ts"),
    ]);
    const session = new CoderSession({
      config,
      provider,
      strategy: new ContextEditStrategy(),
    });
    await expect(
      selectContextFiles(session, "fix it", {
        candidates: ["src/a.ts", "src/b.ts"],
      }),
    ).resolves.toEqual({
      paths: ["src/a.ts", "src/b.ts"],
      iterations: 3,
      converged: true,
    });
    expect(provider.requests).toHaveLength(3);
  });

  it("stops at the configured bound when selection oscillates", async () => {
    const session = new CoderSession({
      config,
      provider: new FakeProvider([turn("a.ts"), turn("b.ts")]),
      strategy: new ContextEditStrategy(),
    });
    await expect(
      selectContextFiles(session, "fix", {
        candidates: ["a.ts", "b.ts"],
        maxIterations: 2,
      }),
    ).resolves.toEqual({
      paths: ["b.ts"],
      iterations: 2,
      converged: false,
    });
  });

  it("propagates cancellation without another iteration", async () => {
    const controller = new AbortController();
    const session = new CoderSession({
      config,
      provider: new FakeProvider([
        { actions: [{ type: "delay", milliseconds: 50 }] },
      ]),
      strategy: new ContextEditStrategy(),
    });
    setTimeout(() => controller.abort(), 1);
    await expect(
      selectContextFiles(session, "fix", {
        candidates: ["a.ts"],
        signal: controller.signal,
      }),
    ).rejects.toThrow(TurnCancelledError);
  });
});
