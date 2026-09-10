import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  CoderSession,
  FakeProvider,
  PatchEditStrategy,
  PatchParseError,
  resolveEditBatch,
} from "../src/index.js";

const strategy = new PatchEditStrategy();
const context = (content = "one\ntwo\nthree\n") => ({
  editablePaths: ["a.txt"],
  fence: ["```", "```"] as const,
  files: [
    { path: "a.txt", content },
    { path: "new.txt", content: null },
  ],
});

describe("PatchEditStrategy", () => {
  it("parses add, delete, update, and update-move actions", () => {
    const result = strategy.parse(
      "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Delete File: gone.txt\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n one\n-two\n+changed\n three\n*** End Patch",
      context(),
    );
    expect(result.fuzz).toBe(0);
    expect(result.edits).toEqual([
      { kind: "create", path: "new.txt", content: "hello\n" },
      { kind: "delete", path: "gone.txt" },
      {
        kind: "move",
        fromPath: "a.txt",
        path: "moved.txt",
        content: "one\nchanged\nthree\n",
      },
    ]);
  });

  it("accounts separately for trailing and surrounding whitespace fuzz", () => {
    const trailing = strategy.parse(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-one   \n+changed\n*** End Patch",
      context("one\n"),
    );
    const surrounding = strategy.parse(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-  one  \n+changed\n*** End Patch",
      context("one\n"),
    );
    expect(trailing.fuzz).toBe(1);
    expect(surrounding.fuzz).toBe(100);
  });

  it("prefers end-of-file context and accounts for fallback placement", () => {
    const atEnd = strategy.parse(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-two\n+changed\n*** End of File\n*** End Patch",
      context("one\ntwo\n"),
    );
    const fallback = strategy.parse(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+changed\n*** End of File\n*** End Patch",
      context("one\ntwo\n"),
    );
    expect(atEnd.fuzz).toBe(0);
    expect(fallback.fuzz).toBe(10_000);
  });

  it("resolves patch updates during a session turn with explicit snapshots", async () => {
    const provider = new FakeProvider([
      {
        actions: [
          {
            type: "text-delta",
            text: "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+changed\n*** End Patch",
          },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const session = new CoderSession({
      config: {
        root: "/repo",
        model: { name: "fake", provider: "fake", editFormat: "patch" },
      },
      provider,
      strategy,
      editablePaths: ["a.txt"],
    });
    await expect(
      session.runTurn("change it", {
        snapshots: [{ path: "a.txt", content: "one\n" }],
      }),
    ).resolves.toMatchObject({ edits: { fuzz: 0 } });
  });

  it("round trips generated exact single-line updates", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((value) => !/[\r\n]/u.test(value)),
        (value) => {
          const batch = strategy.parse(
            `*** Begin Patch\n*** Update File: a.txt\n@@\n-${value}\n+changed\n*** End Patch`,
            context(`${value}\n`),
          );
          expect(
            resolveEditBatch(batch, [{ path: "a.txt", content: `${value}\n` }])
              .operations[0],
          ).toMatchObject({ content: "changed\n" });
        },
      ),
    );
  });

  it("targets a named scope instead of the first matching context", () => {
    const source =
      "function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 1;\n}\n";
    const scoped = strategy.parse(
      "*** Begin Patch\n*** Update File: a.txt\n@@ function beta() {\n-  return 1;\n+  return 2;\n*** End Patch",
      context(source),
    );
    const unscoped = strategy.parse(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-  return 1;\n+  return 2;\n*** End Patch",
      context(source),
    );

    expect(scoped.edits).toEqual([
      {
        kind: "rewrite",
        path: "a.txt",
        content:
          "function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 2;\n}\n",
      },
    ]);
    expect(unscoped.edits).toEqual([
      {
        kind: "rewrite",
        path: "a.txt",
        content:
          "function alpha() {\n  return 2;\n}\nfunction beta() {\n  return 1;\n}\n",
      },
    ]);
  });

  it("rejects a scope that the file does not contain", () => {
    expect(() =>
      strategy.parse(
        "*** Begin Patch\n*** Update File: a.txt\n@@ function missing() {\n-one\n+ONE\n*** End Patch",
        context(),
      ),
    ).toThrow(/Could not find scope context/);
  });

  it("merges repeated update blocks for one path into a single edit", () => {
    const result = strategy.parse(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-three\n+THREE\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** End Patch",
      context(),
    );

    expect(result.edits).toEqual([
      { kind: "rewrite", path: "a.txt", content: "ONE\ntwo\nTHREE\n" },
    ]);
  });

  it("keeps a move target across merged update blocks and rejects a second target", () => {
    const merged = strategy.parse(
      "*** Begin Patch\n*** Update File: a.txt\n*** Move to: moved.txt\n@@\n-one\n+ONE\n*** Update File: a.txt\n@@\n-three\n+THREE\n*** End Patch",
      context(),
    );
    expect(merged.edits).toEqual([
      {
        kind: "move",
        fromPath: "a.txt",
        path: "moved.txt",
        content: "ONE\ntwo\nTHREE\n",
      },
    ]);

    expect(() =>
      strategy.parse(
        "*** Begin Patch\n*** Update File: a.txt\n*** Move to: first.txt\n@@\n-one\n+ONE\n*** Update File: a.txt\n*** Move to: second.txt\n@@\n-three\n+THREE\n*** End Patch",
        context(),
      ),
    ).toThrow(/Conflicting move targets/);
  });

  it("rejects repeated update blocks that change the same lines", () => {
    expect(() =>
      strategy.parse(
        "*** Begin Patch\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** Update File: a.txt\n@@\n-one\n+FIRST\n*** End Patch",
        context(),
      ),
    ).toThrow(/Overlapping or out-of-order chunk/);
  });

  it("rejects conflicting actions and ignores a duplicate delete", () => {
    expect(() =>
      strategy.parse(
        "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Delete File: new.txt\n*** End Patch",
        context(),
      ),
    ).toThrow(/Conflicting actions for file: new.txt/);
    expect(() =>
      strategy.parse(
        "*** Begin Patch\n*** Delete File: a.txt\n*** Update File: a.txt\n@@\n-one\n+ONE\n*** End Patch",
        context(),
      ),
    ).toThrow(/Conflicting actions for file: a.txt/);
    expect(() =>
      strategy.parse(
        "*** Begin Patch\n*** Add File: new.txt\n+hello\n*** Add File: new.txt\n+again\n*** End Patch",
        context(),
      ),
    ).toThrow(/Duplicate action for file: new.txt/);

    expect(
      strategy.parse(
        "*** Begin Patch\n*** Delete File: a.txt\n*** Delete File: a.txt\n*** End Patch",
        context(),
      ).edits,
    ).toEqual([{ kind: "delete", path: "a.txt" }]);
  });

  it("rejects malformed add lines and missing update context", () => {
    expect(() =>
      strategy.parse("*** Add File: x\nmissing-prefix", context()),
    ).toThrow(PatchParseError);
    expect(() =>
      strategy.parse("*** Update File: a.txt\n@@\n-missing\n+new", context()),
    ).toThrow(/Could not find patch context/);
  });
});
