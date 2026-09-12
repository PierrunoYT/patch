import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConcreteApplicationService,
  FakeProvider,
  loadReadOnlyMedia,
  MAX_MEDIA_FILE_BYTES,
} from "../src/index.js";

const roots: string[] = [];

async function temporaryDirectory(prefix = "patch-media-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const pdf = Buffer.from("%PDF-1.7\nprivate-pdf-payload\n%%EOF\n");
const turn = {
  actions: [
    { type: "text-delta" as const, text: "media answer" },
    { type: "finish" as const, reason: "stop" as const },
  ],
};

describe("contained media context", () => {
  it("loads only bounded, contained media whose magic matches its extension", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "image.png"), png);
    await writeFile(join(root, "document.pdf"), pdf);
    await writeFile(
      join(root, "encrypted.pdf"),
      "%PDF-1.7\n/Encrypt private\n%%EOF\n",
    );
    await writeFile(join(root, "fake.png"), "not an image");
    await writeFile(
      join(root, "large.png"),
      Buffer.alloc(MAX_MEDIA_FILE_BYTES + 1),
    );

    await expect(loadReadOnlyMedia(root, "image.png")).resolves.toMatchObject({
      path: "image.png",
      mediaType: "image/png",
      data: png.toString("base64"),
    });
    await expect(
      loadReadOnlyMedia(root, "document.pdf"),
    ).resolves.toMatchObject({
      path: "document.pdf",
      mediaType: "application/pdf",
    });
    await expect(loadReadOnlyMedia(root, "fake.png")).rejects.toThrow(
      "does not match",
    );
    await expect(loadReadOnlyMedia(root, "encrypted.pdf")).rejects.toThrow(
      "does not match",
    );
    await expect(loadReadOnlyMedia(root, "large.png")).rejects.toThrow(
      `${MAX_MEDIA_FILE_BYTES}`,
    );
    await expect(loadReadOnlyMedia(root, "notes.txt")).rejects.toThrow(
      "Unsupported media type",
    );
  });

  it("rejects escapes and cancellation before retaining bytes", async () => {
    const root = await temporaryDirectory();
    const outside = await temporaryDirectory("patch-media-outside-");
    await writeFile(join(outside, "private.png"), png);
    await symlink(join(outside, "private.png"), join(root, "escape.png"));
    await expect(loadReadOnlyMedia(root, "escape.png")).rejects.toThrow(
      "outside the selected root",
    );

    await writeFile(join(root, "image.png"), png);
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadReadOnlyMedia(root, "image.png", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("attaches approved image and PDF context without persisting media bytes", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "image.png"), png);
    await writeFile(join(root, "document.pdf"), pdf);
    const approved: string[] = [];
    const provider = new FakeProvider([turn, turn]);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "sonnet", "--edit-format", "ask"],
      dependencies: {
        provider,
        approvePath: (path) => {
          approved.push(path);
          return true;
        },
      },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "media",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    await expect(
      submit("/attach image.png document.pdf"),
    ).resolves.toMatchObject({ response: "Attached: image.png, document.pdf" });
    expect(approved).toEqual(["image.png", "document.pdf"]);
    await expect(submit("describe them")).resolves.toMatchObject({
      response: "media answer",
    });
    const serializedRequest = JSON.stringify(provider.requests[0]);
    expect(serializedRequest).toContain(png.toString("base64"));
    expect(serializedRequest).toContain(pdf.toString("base64"));
    const serializedHistory = JSON.stringify(await session.snapshot());
    expect(serializedHistory).not.toContain(png.toString("base64"));
    expect(serializedHistory).not.toContain(pdf.toString("base64"));
    expect(serializedHistory).not.toContain("private-pdf-payload");
    await submit("/drop image.png document.pdf");
    await submit("describe what remains");
    expect(JSON.stringify(provider.requests[1])).not.toContain(
      png.toString("base64"),
    );
    expect(JSON.stringify(provider.requests[1])).not.toContain(
      pdf.toString("base64"),
    );
    await service.close();
  });

  it("requires approval and model capability before attaching", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "image.png"), png);
    await writeFile(join(root, "document.pdf"), pdf);
    const denied = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: {
        provider: new FakeProvider([]),
        approvePath: () => false,
      },
    });
    const deniedSession = await denied.createSession({
      principal: "test",
      sessionId: "denied-media",
    });
    const submit = (message: string) =>
      deniedSession.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });
    await expect(submit("/attach image.png")).rejects.toThrow("not approved");
    await expect(submit("/attach document.pdf")).rejects.toThrow(
      "does not support",
    );
    await denied.close();

    const noApprover = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "4o", "--edit-format", "ask"],
      dependencies: { provider: new FakeProvider([]) },
    });
    const noApproverSession = await noApprover.createSession({
      principal: "test",
      sessionId: "missing-approval",
    });
    await expect(
      noApproverSession.submit("/attach image.png", {
        signal: new AbortController().signal,
        emit: () => undefined,
      }),
    ).rejects.toThrow("not approved");
    await noApprover.close();
  });

  it("bounds attachment count and aggregate bytes atomically", async () => {
    const root = await temporaryDirectory();
    for (let index = 1; index <= 5; index += 1) {
      await writeFile(join(root, `${index}.png`), png);
    }
    const padded = Buffer.concat([
      png.subarray(0, -12),
      Buffer.alloc(4 * 1024 * 1024),
      png.subarray(-12),
    ]);
    for (const name of ["large-a.png", "large-b.png", "large-c.png"])
      await writeFile(join(root, name), padded);
    const service = await ConcreteApplicationService.create({
      cwd: root,
      home: root,
      environment: {},
      argv: ["--no-git", "--model", "sonnet", "--edit-format", "ask"],
      dependencies: { provider: new FakeProvider([]), approvePath: () => true },
    });
    const session = await service.createSession({
      principal: "test",
      sessionId: "bounded-media",
    });
    const submit = (message: string) =>
      session.submit(message, {
        signal: new AbortController().signal,
        emit: () => undefined,
      });

    await expect(
      submit("/attach 1.png 2.png 3.png 4.png 5.png"),
    ).rejects.toThrow("At most 4");
    await expect(
      submit("/attach large-a.png large-b.png large-c.png"),
    ).rejects.toThrow("may total at most");
    await expect(submit("/ls")).resolves.toMatchObject({
      response: expect.stringContaining("Media: (none)"),
    });
    await service.close();
  });
});
