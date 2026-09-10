import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  UnsupportedEditFormatError,
  createStrategy,
} from "../src/index.js";

function completed(text: string) {
  return {
    actions: [
      { type: "text-delta" as const, text },
      { type: "finish" as const, reason: "stop" as const },
    ],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "patch-application-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "edit.ts"), "export const editable = 1;\n");
  await writeFile(join(root, "src", "read.ts"), "export const readonly = 2;\n");
  return root;
}

describe("ConcreteApplicationService", () => {
  it("composes current editable/read-only context and serial multi-turn history", async () => {
    const root = await fixture();
    const provider = new FakeProvider([
      completed("first"),
      completed("second"),
    ]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: [
        "--no-git",
        "--model",
        "4o",
        "--edit-format",
        "ask",
        "--file",
        "src/edit.ts",
        "--read-only",
        "src/read.ts",
      ],
      dependencies: { provider },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "one",
    });
    const controller = new AbortController();
    const emitted: string[] = [];
    const options = {
      signal: controller.signal,
      emit: (event: { type: string; data: unknown }) =>
        emitted.push(event.type),
    };

    await expect(
      Promise.all([
        session.submit("inspect the constants", options),
        session.submit("and summarize", options),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ response: "first" }),
      expect.objectContaining({ response: "second" }),
    ]);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("export const editable = 1"),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("export const readonly = 2"),
        }),
      ]),
    );
    expect(provider.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: "first" }),
      ]),
    );
    expect(emitted).toEqual(["text-delta", "finish", "text-delta", "finish"]);
  });

  it("rejects conflicting selections and paths outside the selected root", async () => {
    const root = await fixture();
    const provider = new FakeProvider([]);
    const create = (paths: string[]) =>
      ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: ["--no-git", "--model", "4o", ...paths],
        dependencies: { provider },
      });

    await expect(
      create(["--file", "src/edit.ts", "--read-only", "src/edit.ts"]),
    ).rejects.toThrow(/both editable and read-only/);
    await expect(create(["--file", "../outside.ts"])).rejects.toThrow(
      /outside the selected root/,
    );
  });

  it("fails before session input when model credentials are unavailable", async () => {
    const root = await fixture();
    await expect(
      ConcreteApplicationService.create({
        cwd: root,
        home: root,
        environment: {},
        argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      }),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });
});

describe("application strategy registry", () => {
  it("constructs implemented modes and rejects schema-only modes", () => {
    expect(createStrategy("diff-fenced").strategy.format).toBe("diff-fenced");
    expect(() => createStrategy("architect")).toThrow(
      UnsupportedEditFormatError,
    );
  });
});
