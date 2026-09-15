import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  ModelCatalog,
  type ModelProvider,
  type ModelSettings,
  RepositoryMap,
  type RepositoryMapRequest,
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
        { type: "usage", inputTokens: 10, outputTokens: 5 },
        { type: "finish", reason: "stop" },
      ],
    })),
  );
}

interface Harness {
  readonly provider: FakeProvider;
  readonly submit: (message: string) => Promise<unknown>;
  readonly sent: (index: number) => string;
  readonly totalCost: () => Promise<number>;
  readonly close: () => Promise<void>;
}

async function harness(options: {
  readonly root: string;
  readonly argv: readonly string[];
  readonly turns?: number;
  readonly createProvider?: (
    model: ModelSettings,
    scripted: ModelProvider,
  ) => ModelProvider;
  readonly signal?: AbortSignal;
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
        signal: options.signal ?? controller.signal,
        emit: () => undefined,
      }),
    sent: (index) => JSON.stringify(provider.requests[index]?.messages ?? []),
    totalCost: async () =>
      ((await session.snapshot()) as { totalCost: number }).totalCost,
    close: () => service.close(),
  };
}

describe("editable-file prompt pair", () => {
  it("says no files are shared, and asks which to add when a map exists", async () => {
    const root = await temporaryDirectory("patch-no-files-");
    await writeFile(join(root, "one.txt"), "one\n");
    const { submit, sent } = await harness({
      root,
      turns: 2,
      argv: ["--no-git", "--model", "test/whole-model", "--file", "one.txt"],
    });

    // With a file in context the pair is the contents and the assistant's ack.
    await submit("first question");
    expect(sent(0)).toContain("I have *added these files to the chat*");
    expect(sent(0)).toContain("any changes I propose will be to those files");

    await submit("/drop one.txt");
    await submit("second question");
    expect(sent(1)).toContain("I am not sharing any files that you can edit");
    expect(sent(1)).not.toContain("I have *added these files to the chat*");
  });

  it("asks which files need changes when a repository map is present", async () => {
    const root = await temporaryRepository("patch-no-files-map-");
    await writeFile(
      join(root, "mapped.ts"),
      "export function mappedHelper(value: number): number {\n  return value + 1;\n}\n",
    );
    await executeFile("git", ["-C", root, "add", "."]);
    await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
    const { submit, sent } = await harness({
      root,
      turns: 1,
      argv: ["--model", "test/diff-model"],
    });

    await submit("where is mappedHelper");
    expect(sent(0)).toContain(REPO_MAP_PREFIX);
    expect(sent(0)).toContain(
      "Tell me which files in my repo are the most likely to **need changes**",
    );
    expect(sent(0)).not.toContain(
      "I am not sharing any files that you can edit",
    );
  });
});

describe("read-only and repository wrapper dialogue", () => {
  it("acknowledges both advisory context sections like pinned aider", async () => {
    const root = await temporaryRepository("patch-wrapper-dialogue-");
    await writeFile(join(root, "selected.txt"), "selected\n");
    await writeFile(join(root, "reference.txt"), "reference\n");
    await writeFile(
      join(root, "mapped.ts"),
      "export function mappedHelper(): number { return 1; }\n",
    );
    await executeFile("git", ["-C", root, "add", "."]);
    await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
    const { submit, sent } = await harness({
      root,
      turns: 1,
      argv: [
        "--model",
        "test/diff-model",
        "--file",
        "selected.txt",
        "--read-only",
        "reference.txt",
      ],
    });

    await submit("inspect mappedHelper");
    expect(sent(0)).toContain("Ok, I will use these files as references.");
    expect(sent(0)).toContain(
      "Ok, I won't try and edit those files without asking first.",
    );
  });
});

describe("model prompt role capabilities", () => {
  it("uses a user/assistant preamble when the model rejects system roles", async () => {
    const root = await temporaryDirectory("patch-no-system-role-");
    const catalog = await ModelCatalog.load({
      settings: [
        new URL("./fixtures/switch-models.yml", import.meta.url),
        new URL("./fixtures/no-system-model.yml", import.meta.url),
      ],
    });
    const provider = answering(1);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "test/no-system-model"],
      dependencies: { catalog, provider },
    });
    const session = service.createSession({
      principal: "test",
      sessionId: "no-system",
    });

    await session.submit("question", {
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    expect(provider.requests[0]?.messages[0]).toMatchObject({ role: "user" });
    expect(provider.requests[0]?.messages[1]).toEqual({
      role: "assistant",
      content: "Ok.",
    });
    expect(
      provider.requests[0]?.messages.some(({ role }) => role === "system"),
    ).toBe(false);
    await service.close();
  });
});

describe("bundled prompt placement", () => {
  it("folds GPT-4o examples into the system message and keeps its reminder there", async () => {
    const root = await temporaryDirectory("patch-example-placement-");
    const provider = answering(1);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o"],
      dependencies: { provider },
    });
    const session = service.createSession({
      principal: "test",
      sessionId: "placement",
    });

    await session.submit("question", {
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    const messages = provider.requests[0]?.messages ?? [];
    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("# Example conversations:"),
    });
    expect(
      messages.some(
        ({ content }) =>
          content === "Change get_factorial() to use math.factorial",
      ),
    ).toBe(false);
    expect(messages.at(-1)?.role).toBe("system");
    await service.close();
  });
});

describe("repository-map fallback requests", () => {
  it.each([
    {
      name: "the selected-file map",
      results: ["selected map"],
      expectedCalls: 1,
      expectedMap: "selected map",
    },
    {
      name: "the hinted global map",
      results: ["", "hinted global map"],
      expectedCalls: 2,
      expectedMap: "hinted global map",
    },
    {
      name: "the unhinted global map",
      results: ["", "", "unhinted global map"],
      expectedCalls: 3,
      expectedMap: "unhinted global map",
    },
  ])("stops after $name succeeds", async (scenario) => {
    const root = await temporaryRepository("patch-map-fallback-");
    await writeFile(join(root, "chat.ts"), "export const chatValue = 1;\n");
    await writeFile(
      join(root, "mapped.ts"),
      "export function mappedHelper(): number { return 2; }\n",
    );
    await executeFile("git", ["-C", root, "add", "."]);
    await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
    const requests: RepositoryMapRequest[] = [];
    const results = [...scenario.results];
    const map = vi
      .spyOn(RepositoryMap.prototype, "getMap")
      .mockImplementation((request) => {
        requests.push(request);
        return Promise.resolve(results.shift() ?? "");
      });
    const application = await harness({
      root,
      turns: 1,
      argv: ["--model", "test/diff-model", "--file", "chat.ts"],
    });

    try {
      await application.submit("inspect mapped.ts and mappedHelper");

      expect(requests).toHaveLength(scenario.expectedCalls);
      expect(requests[0]).toMatchObject({
        chatPaths: ["chat.ts"],
        otherPaths: ["mapped.ts"],
        mentionedPaths: ["mapped.ts"],
        mentionedIdentifiers: expect.arrayContaining(["mappedHelper"]),
      });
      if (scenario.expectedCalls >= 2) {
        expect(requests[1]).toMatchObject({
          chatPaths: [],
          otherPaths: expect.arrayContaining(["chat.ts", "mapped.ts"]),
          mentionedPaths: ["mapped.ts"],
          mentionedIdentifiers: expect.arrayContaining(["mappedHelper"]),
        });
      }
      if (scenario.expectedCalls === 3) {
        expect(requests[2]).toEqual({
          chatPaths: [],
          otherPaths: ["chat.ts", "mapped.ts"],
        });
      }
      expect(application.sent(0)).toContain(scenario.expectedMap);
    } finally {
      await application.close();
      map.mockRestore();
    }
  });
});

describe("tracked-file inventory", () => {
  it("re-reads the inventory each turn instead of freezing it at startup", async () => {
    const root = await temporaryRepository("patch-inventory-");
    await writeFile(join(root, "chat.txt"), "selected\n");
    await writeFile(
      join(root, "first.ts"),
      "export function firstHelper(): number {\n  return 1;\n}\n",
    );
    await executeFile("git", ["-C", root, "add", "."]);
    await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
    const { submit, sent } = await harness({
      root,
      turns: 2,
      argv: ["--model", "test/diff-model", "--file", "chat.txt"],
    });

    await submit("where is firstHelper");
    expect(sent(0)).toContain("first.ts");
    expect(sent(0)).not.toContain("second.ts");

    // A file committed mid-session has to appear without restarting Patch.
    await writeFile(
      join(root, "second.ts"),
      "export function secondHelper(): number {\n  return 2;\n}\n",
    );
    await executeFile("git", ["-C", root, "add", "second.ts"]);
    await executeFile("git", ["-C", root, "commit", "--quiet", "-m", "second"]);

    await submit("where is secondHelper");
    expect(sent(1)).toContain("second.ts");
  });
});

describe("long completed history", () => {
  it("summarizes with the weak model before the next turn", async () => {
    const root = await temporaryDirectory("patch-summary-app-");
    await writeFile(join(root, "one.txt"), "one\n");
    const { submit, provider, sent } = await harness({
      root,
      // The first turn, the summarization request, then the second turn.
      turns: 3,
      argv: [
        "--no-git",
        "--model",
        "test/summarizing-model",
        "--file",
        "one.txt",
      ],
    });

    await submit("first question");
    await submit("second question");

    expect(provider.requests).toHaveLength(3);
    // The middle request is the summarization, addressed to the weak model.
    expect(provider.requests[1]?.model).toBe("test/weak-model");
    expect(sent(1)).toContain("Briefly* summarize this partial conversation");
    expect(sent(1)).toContain("# ASSISTANT");
    // The real turn then carries the summary instead of the raw exchange.
    expect(sent(2)).toContain("I spoke to you previously about a number of");
  });

  it("charges the session for the summarization it paid for", async () => {
    const root = await temporaryDirectory("patch-summary-cost-");
    await writeFile(join(root, "one.txt"), "one\n");
    const { submit, provider, totalCost } = await harness({
      root,
      turns: 3,
      argv: [
        "--no-git",
        "--model",
        "test/summarizing-model",
        "--file",
        "one.txt",
      ],
    });

    await submit("first question");
    const afterOne = await totalCost();
    await submit("second question");

    // Three provider requests were made and three were billed: the two turns
    // and the weak-model summarization between them. Dropping the summarizer's
    // usage events made the reported total stop at the two turns.
    expect(provider.requests).toHaveLength(3);
    expect(await totalCost()).toBeCloseTo(afterOne * 3, 10);
  });

  it("falls back to the main model and charges a failed weak attempt", async () => {
    const root = await temporaryDirectory("patch-summary-fallback-");
    await writeFile(join(root, "one.txt"), "one\n");
    let weakRequests = 0;
    let weakCloses = 0;
    const weak: ModelProvider = {
      async *stream() {
        weakRequests += 1;
        yield { type: "usage", inputTokens: 100, outputTokens: 0 };
        yield {
          type: "error",
          kind: "provider",
          message: "weak summary failed",
          retryable: false,
        };
      },
      close() {
        weakCloses += 1;
      },
    };
    const { submit, provider, sent, totalCost, close } = await harness({
      root,
      turns: 3,
      argv: [
        "--no-git",
        "--model",
        "test/summarizing-model",
        "--file",
        "one.txt",
      ],
      createProvider: (model, scripted) =>
        model.name === "test/weak-model" ? weak : scripted,
    });

    await submit("first question");
    const afterOne = await totalCost();
    await submit("second question");

    expect(weakRequests).toBe(1);
    expect(weakCloses).toBe(1);
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]?.model).toBe("test/summarizing-model");
    expect(sent(2)).toContain("I spoke to you previously about a number of");
    expect(await totalCost()).toBeCloseTo(afterOne * 3 + 0.0001, 10);
    await close();
  });

  it("keeps raw history when both summarizer models fail", async () => {
    const root = await temporaryDirectory("patch-summary-all-fail-");
    await writeFile(join(root, "one.txt"), "one\n");
    let mainCreations = 0;
    const closed: string[] = [];
    const failing = (name: string): ModelProvider => ({
      async *stream() {
        yield {
          type: "error",
          kind: "provider",
          message: `${name} summary failed`,
          retryable: false,
        };
      },
      close() {
        closed.push(name);
      },
    });
    const { submit, provider, sent, close } = await harness({
      root,
      turns: 2,
      argv: [
        "--no-git",
        "--model",
        "test/summarizing-model",
        "--file",
        "one.txt",
      ],
      createProvider: (model, scripted) => {
        if (model.name === "test/weak-model") return failing("weak");
        mainCreations += 1;
        return mainCreations === 1 ? scripted : failing("main");
      },
    });

    await submit("first question");
    await submit("second question");

    expect(provider.requests).toHaveLength(2);
    expect(sent(1)).toContain("first question");
    expect(sent(1)).toContain("assistant answer");
    expect(sent(1)).not.toContain(
      "I spoke to you previously about a number of",
    );
    expect(closed).toEqual(["weak", "main"]);
    await close();
  });

  it("does not fall back after summarization is cancelled", async () => {
    const root = await temporaryDirectory("patch-summary-cancel-");
    await writeFile(join(root, "one.txt"), "one\n");
    const controller = new AbortController();
    let mainCreations = 0;
    let weakCloses = 0;
    const { submit, close } = await harness({
      root,
      turns: 1,
      signal: controller.signal,
      argv: [
        "--no-git",
        "--model",
        "test/summarizing-model",
        "--file",
        "one.txt",
      ],
      createProvider: (model, scripted) => {
        if (model.name !== "test/weak-model") {
          mainCreations += 1;
          return scripted;
        }
        return {
          async *stream(_request, signal) {
            controller.abort(new Error("summary cancelled"));
            signal?.throwIfAborted();
            yield { type: "finish", reason: "cancelled" };
          },
          close() {
            weakCloses += 1;
          },
        };
      },
    });

    await submit("first question");
    await expect(submit("second question")).rejects.toThrow(
      "summary cancelled",
    );
    expect(mainCreations).toBe(1);
    expect(weakCloses).toBe(1);
    await close();
  });
});

describe("switching the active model", () => {
  it("summarizes incompatible history before installing the new format", async () => {
    const root = await temporaryDirectory("patch-switch-prompt-");
    await writeFile(join(root, "one.txt"), "one\n");
    const provider = new FakeProvider([
      {
        actions: [
          { type: "text-delta", text: "assistant answer" },
          { type: "finish", reason: "stop" },
        ],
      },
      {
        actions: [
          { type: "text-delta", text: "I asked you to make the first change." },
          { type: "finish", reason: "stop" },
        ],
      },
      {
        actions: [
          { type: "text-delta", text: "second answer" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "test/diff-model", "--file", "one.txt"],
      dependencies: { catalog: await testCatalog, provider },
    });
    const session = service.createSession({
      principal: "test",
      sessionId: "switch-summary",
    });
    const options = {
      signal: new AbortController().signal,
      emit: () => undefined,
    };

    await session.submit("first question", options);
    await expect(
      session.submit("/model test/whole-model", options),
    ).resolves.toMatchObject({
      response: "Model: test/whole-model",
    });
    await session.submit("second question", options);

    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("SEARCH");
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain(
      "Briefly* summarize this partial conversation",
    );
    const replacement = JSON.stringify(provider.requests[2]?.messages);
    expect(replacement).toContain("entire content of the updated file");
    expect(replacement).toContain("I asked you to make the first change.");
    expect(replacement).not.toContain("assistant answer");
    await service.close();
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
      turns: 3,
      argv: ["--model", "test/diff-model", "--file", "chat.txt"],
    });

    await submit("where is mappedHelper");
    expect(sent(0)).toContain(REPO_MAP_PREFIX);

    await submit("/model test/whole-model");
    await submit("where is mappedHelper");
    expect(sent(2)).not.toContain(REPO_MAP_PREFIX);
  });

  it("reselects the fence after context changes without a profile switch", async () => {
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
    await submit("second question");
    expect(sent(1)).toContain("one.txt\\n````\\none\\n````");
    expect(sent(1)).toContain("````python");
    expect(sent(1)).toContain("The closing fence: ````");
  });

  it("sends the distinct fenced-diff protocol with the active fence", async () => {
    const root = await temporaryDirectory("patch-fenced-diff-prompt-");
    await writeFile(join(root, "fenced.md"), "```\nembedded\n```\n");
    const common = [
      "--no-git",
      "--model",
      "test/diff-model",
      "--file",
      "fenced.md",
    ];
    const ordinary = await harness({
      root,
      turns: 1,
      argv: [...common, "--edit-format", "diff"],
    });
    const fenced = await harness({
      root,
      turns: 1,
      argv: [...common, "--edit-format", "diff-fenced"],
    });

    await ordinary.submit("change the value");
    await fenced.submit("change the value");

    expect(ordinary.sent(0)).toContain(
      "mathweb/flask/app.py\\n````python\\n<<<<<<< SEARCH",
    );
    expect(ordinary.sent(0)).not.toContain(
      "````python\\nmathweb/flask/app.py\\n<<<<<<< SEARCH",
    );
    expect(fenced.sent(0)).toContain(
      "````python\\nmathweb/flask/app.py\\n<<<<<<< SEARCH",
    );
    expect(fenced.sent(0)).not.toContain(
      "mathweb/flask/app.py\\n````python\\n<<<<<<< SEARCH",
    );
    expect(fenced.sent(0)).toContain("The closing fence: ````");
  });

  it("cancels switch-time history summarization without installing the profile", async () => {
    const root = await temporaryDirectory("patch-switch-cancel-");
    await writeFile(join(root, "one.txt"), "one\n");
    const controller = new AbortController();
    let creations = 0;
    const { submit, close } = await harness({
      root,
      signal: controller.signal,
      argv: ["--no-git", "--model", "test/diff-model", "--file", "one.txt"],
      createProvider: (_model, scripted) => {
        creations += 1;
        if (creations === 1) return scripted;
        return {
          stream(_request, signal) {
            controller.abort(new Error("switch summary cancelled"));
            signal?.throwIfAborted();
            return (async function* () {})();
          },
        };
      },
      turns: 1,
    });

    await submit("first question");
    await expect(submit("/model test/whole-model")).rejects.toThrow(
      "switch summary cancelled",
    );
    await close();
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
    expect(sent(1)).not.toContain("entire content of the updated file");
    await expect(submit("/chat-mode code")).resolves.toMatchObject({
      response: "Chat mode: diff",
    });
  });
});
