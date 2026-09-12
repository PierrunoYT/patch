import { describe, expect, it, vi } from "vitest";

import {
  ArchitectEditStrategy,
  ArchitectOrchestrator,
  CoderSession,
  FakeProvider,
  SearchReplaceEditStrategy,
} from "../src/index.js";

const config = (_editFormat: "architect" | "diff") => ({
  root: "/repo",
  model: { name: "fake", provider: "fake", editFormat: "ask" as const },
});
const finish = (text: string) => [
  {
    actions: [
      { type: "text-delta" as const, text },
      { type: "finish" as const, reason: "stop" as const },
    ],
  },
];

describe("ArchitectOrchestrator", () => {
  it("requires acceptance before sending the plan to the editor", async () => {
    const architectProvider = new FakeProvider(
      finish("Change a.txt from old to new."),
    );
    const editorProvider = new FakeProvider(
      finish("a.txt\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n"),
    );
    const orchestrator = new ArchitectOrchestrator(
      new CoderSession({
        config: config("architect"),
        provider: architectProvider,
        strategy: new ArchitectEditStrategy(),
      }),
      new CoderSession({
        config: config("diff"),
        provider: editorProvider,
        strategy: new SearchReplaceEditStrategy(),
        editablePaths: ["a.txt"],
      }),
    );
    const accept = vi.fn(() => true);
    const result = await orchestrator.run("make it new", { accept });
    expect(accept).toHaveBeenCalledWith({
      plan: "Change a.txt from old to new.",
    });
    expect(editorProvider.requests[0]?.messages.at(-1)?.content).toBe(
      "Change a.txt from old to new.",
    );
    expect(result.editor?.edits.edits).toHaveLength(1);
  });

  it("does not invoke the editor when acceptance is denied", async () => {
    const editorProvider = new FakeProvider(finish("unused"));
    const orchestrator = new ArchitectOrchestrator(
      new CoderSession({
        config: config("architect"),
        provider: new FakeProvider(finish("plan")),
        strategy: new ArchitectEditStrategy(),
      }),
      new CoderSession({
        config: config("diff"),
        provider: editorProvider,
        strategy: new SearchReplaceEditStrategy(),
      }),
    );
    expect(
      await orchestrator.run("request", { accept: () => false }),
    ).toMatchObject({ accepted: false });
    expect(editorProvider.requests).toHaveLength(0);
  });
});
