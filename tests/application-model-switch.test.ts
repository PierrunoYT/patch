import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  ModelCatalog,
  type ModelProvider,
  type ModelSettings,
} from "../src/index.js";

const executeFile = promisify(execFile);
const directories: string[] = [];

const REPO_MAP_PREFIX =
  "Here are summaries of some files present in my git repository.";

const testCatalog = ModelCatalog.load({
  settings: [new URL("./fixtures/switch-models.yml", import.meta.url)],
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}

async function temporaryRepository(prefix: string): Promise<string> {
  const root = await temporaryDirectory(prefix);
  await executeFile("git", ["init", "--quiet", root]);
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
  ] satisfies [string, string][]) {
    await executeFile("git", ["-C", root, "config", key, value]);
  }
  return root;
}

function answering(turns: number): FakeProvider {
  return new FakeProvider(
    Array.from({ length: turns }, () => ({
      actions: [
        { type: "text-delta", text: "assistant answer" },
        { type: "finish", reason: "stop" },
      ],
    })),
  );
}

interface Harness {
  readonly provider: FakeProvider;
  readonly submit: (message: string) => Promise<unknown>;
  readonly sent: (index: number) => string;
}

async function harness(options: {
  readonly root: string;
  readonly argv: readonly string[];
  readonly turns?: number;
  readonly createProvider?: (
    model: ModelSettings,
    scripted: ModelProvider,
  ) => ModelProvider;
}): Promise<Harness> {
  const provider = answering(options.turns ?? 0);
  const build = options.createProvider;
  const service = await ConcreteApplicationService.create({
    cwd: options.root,
    home: options.root,
    environment: {},
    argv: [...options.argv],
    dependencies: {
      catalog: await testCatalog,
      ...(build === undefined
        ? { provider }
        : { createProvider: (model: ModelSettings) => build(model, provider) }),
    },
  });
  const session = await service.createSession({
    principal: "test",
    sessionId: "switch",
  });
  const controller = new AbortController();
  return {
    provider,
    submit: (message) =>
      session.submit(message, {
        signal: controller.signal,
        emit: () => undefined,
      }),
    sent: (index) => JSON.stringify(provider.requests[index]?.messages ?? []),
  };
}

describe("switching the active model", () => {
  it("rebuilds prompts, shell policy, and compatible history", async () => {
    const root = await temporaryDirectory("patch-switch-prompt-");
    await writeFile(join(root, "one.txt"), "one\n");
    const { submit, sent } = await harness({
      root,
      turns: 2,
      argv: ["--no-git", "--model", "test/diff-model", "--file", "one.txt"],
    });

    await submit("first question");
    expect(sent(0)).toContain("SEARCH");
    expect(sent(0)).toContain("Shell commands may be suggested");

    await expect(submit("/model test/whole-model")).resolves.toMatchObject({
      response: "Model: test/whole-model",
    });
    await submit("second question");

    // The replacement model's own prompt, reminder, and shell policy.
    expect(sent(1)).toContain("complete fenced file body");
    expect(sent(1)).not.toContain("SEARCH");
    expect(sent(1)).toContain("Do not suggest shell commands.");
    // Assistant output in the previous format cannot survive the format change.
    expect(sent(0)).toContain("first question");
    expect(sent(1)).toContain("first question");
    expect(sent(1)).not.toContain("assistant answer");
  });

  it("returns /chat-mode code to the active model's format", async () => {
    const root = await temporaryDirectory("patch-switch-mode-");
    const { submit } = await harness({
      root,
      argv: ["--no-git", "--model", "test/diff-model"],
    });

    await submit("/model test/whole-model");
    await expect(submit("/chat-mode ask")).resolves.toMatchObject({
      response: "Chat mode: ask",
    });
    await expect(submit("/chat-mode code")).resolves.toMatchObject({
      response: "Chat mode: whole",
    });
  });

  it("keeps an explicit startup edit format across a chat-mode round trip", async () => {
    const root = await temporaryDirectory("patch-switch-format-");
    const { submit } = await harness({
      root,
      argv: [
        "--no-git",
        "--model",
        "test/diff-model",
        "--edit-format",
        "whole",
      ],
    });

    await submit("/chat-mode ask");
    await expect(submit("/chat-mode code")).resolves.toMatchObject({
      response: "Chat mode: whole",
    });
  });

  it("applies the replacement model's repository-map policy", async () => {
    const root = await temporaryRepository("patch-switch-map-");
    await writeFile(join(root, "chat.txt"), "selected\n");
    await writeFile(
      join(root, "mapped.ts"),
      "export function mappedHelper(value: number): number {\n  return value + 1;\n}\n",
    );
    await executeFile("git", ["-C", root, "add", "."]);
    await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
    const { submit, sent } = await harness({
      root,
      turns: 2,
      argv: ["--model", "test/diff-model", "--file", "chat.txt"],
    });

    await submit("where is mappedHelper");
    expect(sent(0)).toContain(REPO_MAP_PREFIX);

    await submit("/model test/whole-model");
    await submit("where is mappedHelper");
    expect(sent(1)).not.toContain(REPO_MAP_PREFIX);
  });

  it("reselects the fence for the files in context", async () => {
    const root = await temporaryDirectory("patch-switch-fence-");
    await writeFile(join(root, "one.txt"), "one\n");
    await writeFile(join(root, "fenced.md"), "```\nembedded\n```\n");
    const { submit, sent } = await harness({
      root,
      turns: 2,
      argv: ["--no-git", "--model", "test/diff-model", "--file", "one.txt"],
    });

    await submit("first question");
    expect(sent(0)).toContain("one.txt\\n```\\none\\n```");

    await submit("/add fenced.md");
    await submit("/model test/diff-model");
    await submit("second question");
    expect(sent(1)).toContain("one.txt\\n````\\none\\n````");
  });

  it("leaves the previous model active when the switch fails", async () => {
    const root = await temporaryDirectory("patch-switch-atomic-");
    await writeFile(join(root, "one.txt"), "one\n");
    const { submit, sent } = await harness({
      root,
      turns: 2,
      argv: ["--no-git", "--model", "test/diff-model", "--file", "one.txt"],
      createProvider: (model, scripted) => {
        if (model.name === "test/whole-model") {
          throw new Error("provider unavailable");
        }
        return scripted;
      },
    });

    await submit("first question");
    await expect(submit("/model test/whole-model")).rejects.toThrow(
      /provider unavailable/u,
    );

    await submit("second question");
    expect(sent(1)).toContain("SEARCH");
    expect(sent(1)).not.toContain("complete fenced file body");
    await expect(submit("/chat-mode code")).resolves.toMatchObject({
      response: "Chat mode: diff",
    });
  });
});
