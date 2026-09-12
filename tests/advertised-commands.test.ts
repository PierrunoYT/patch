import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMMAND_NAMES,
  ConcreteApplicationService,
  FakeProvider,
} from "../src/index.js";

function turn(text: string) {
  return {
    actions: [
      { type: "text-delta" as const, text },
      { type: "finish" as const, reason: "stop" as const },
    ],
  };
}

describe("advertised slash-command surface", () => {
  it("keeps the documented inventory equal to the parser-owned inventory", async () => {
    const documentation = await readFile(
      new URL("../docs/commands.md", import.meta.url),
      "utf8",
    );
    const inventory = /The parser recognizes ([\s\S]*?)\.\nPath commands/u.exec(
      documentation,
    )?.[1];
    expect(inventory).toBeDefined();
    const advertised = [...(inventory ?? "").matchAll(/`\/([a-z-]+)`/gu)].map(
      (match) => match[1],
    );
    expect(new Set(advertised)).toEqual(new Set(COMMAND_NAMES));
    expect(advertised).toHaveLength(COMMAND_NAMES.length);
  });

  it("executes every advertised command effect and preserves safe failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-advertised-commands-"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Patch Tests"], { cwd: root });
    execFileSync("git", ["config", "user.email", "patch@example.invalid"], {
      cwd: root,
    });
    execFileSync("git", ["config", "commit.gpgSign", "false"], { cwd: root });
    await writeFile(join(root, "one.txt"), "one\n");
    await writeFile(join(root, "two.txt"), "two\n");
    execFileSync("git", ["add", "one.txt", "two.txt"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });

    const provider = new FakeProvider([
      turn("first assistant answer"),
      turn("pasted assistant answer"),
    ]);
    let clipboard = "";
    const fetched: string[] = [];
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: [
        "--model",
        "4o",
        "--edit-format",
        "ask",
        "--file",
        "one.txt",
        "--lint-cmd",
        'node -e "process.exit(0)"',
        "--test-cmd",
        'node -e "process.exit(0)"',
      ],
      dependencies: {
        provider,
        approvePath: () => true,
        approveCommand: (command) => !command.includes("denied-command"),
        readClipboard: async () => clipboard,
        writeClipboard: async (text) => {
          clipboard = text;
        },
        fetchUrl: async (url) => {
          fetched.push(url);
          if (url.includes("private.invalid")) throw new Error("URL refused");
          return {
            url,
            contentType: "text/plain",
            content: "bounded page",
            rendered: false,
          };
        },
        reportMetadata: async () => ({
          patchVersion: "0.0.0",
          nodeVersion: "22.1.0",
          platform: "linux",
          release: "6.1.0",
          architecture: "x64",
        }),
      },
    });
    const session = service.createSession({
      principal: "test",
      sessionId: "advertised",
    });
    const options = {
      signal: new AbortController().signal,
      emit: () => undefined,
    };
    const exercised = new Set<string>();
    const submit = async (command: string) => {
      const name = /^\/([a-z-]+)/u.exec(command)?.[1];
      if (name !== undefined) exercised.add(name);
      return session.submit(command, options);
    };

    await expect(submit("/copy")).rejects.toThrow(/no assistant text/u);
    await expect(submit("/undo")).rejects.toThrow(/no Patch commit/u);
    await expect(submit("/add ../outside.txt")).rejects.toThrow(/outside/u);
    await expect(submit("/read-only ../outside.txt")).rejects.toThrow(
      /outside/u,
    );
    await expect(submit("/model unsupported-model")).rejects.toThrow(
      /unknown model/iu,
    );
    await expect(submit("/web https://private.invalid/")).rejects.toThrow(
      /URL refused/u,
    );
    await expect(submit("/run denied-command")).resolves.toMatchObject({
      commands: [{ status: "denied" }],
    });

    await session.submit("question", options);
    await submit("/copy");
    expect(clipboard).toBe("first assistant answer");
    clipboard = "pasted text";
    await submit("/paste");
    await submit("/add two.txt");
    await submit("/read-only two.txt");
    await expect(submit("/ls")).resolves.toMatchObject({
      response: expect.stringContaining("Read-only: two.txt"),
    });
    await submit("/drop two.txt");
    await submit("/model 4o");
    await submit("/chat-mode ask");
    await expect(
      submit('/run node -e "process.exit(0)"'),
    ).resolves.toMatchObject({
      commands: [{ status: "completed", exitCode: 0 }],
    });
    await submit("/lint");
    await submit("/test");
    await submit("/web https://example.com/page");
    expect(fetched).toEqual([
      "https://private.invalid/",
      "https://example.com/page",
    ]);
    await expect(submit("/help command")).resolves.toMatchObject({
      response: expect.stringContaining("commands.md:"),
    });
    await expect(submit("/settings")).resolves.toMatchObject({
      response: expect.stringContaining("Current session:"),
    });
    await expect(submit("/report Review me")).resolves.toMatchObject({
      response: expect.stringContaining("User-supplied title"),
    });
    await writeFile(join(root, "one.txt"), "changed\n");
    await expect(submit("/commit advertised command")).resolves.toMatchObject({
      commit: expect.stringMatching(/^[0-9a-f]{40}$/u),
    });
    await submit("/undo");
    expect(await readFile(join(root, "one.txt"), "utf8")).toBe("changed\n");
    await submit("/clear");
    await expect(submit("/exit")).resolves.toMatchObject({ exit: true });

    expect(exercised).toEqual(new Set(COMMAND_NAMES));
    expect(provider.requests).toHaveLength(2);
    await expect(session.submit("after exit", options)).rejects.toThrow(
      /closed/u,
    );
  });
});
