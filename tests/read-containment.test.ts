import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

let beforeOpen:
  { readonly suffix: string; readonly run: () => Promise<void> } | undefined;

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (
        beforeOpen !== undefined &&
        String(args[0]).endsWith(beforeOpen.suffix)
      ) {
        const hook = beforeOpen.run;
        beforeOpen = undefined;
        await hook();
      }
      return actual.open(...args);
    },
  };
});

// Ensure media and watch mode observe this file's deterministic open hook even
// when the worker previously loaded the application graph in another suite.
vi.resetModules();
const { AiWatchMode, loadReadOnlyMedia, TagExtractor, TreeContextRenderer } =
  await import("../src/index.js");

const directories: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function directory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

async function replaceWithOutsideLink(
  root: string,
  outside: string,
): Promise<void> {
  await rename(join(root, "pkg"), join(root, "moved"));
  await symlink(
    outside,
    join(root, "pkg"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

afterEach(async () => {
  beforeOpen = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("contained read handles", () => {
  it("rejects media redirected by an ancestor swap before open", async () => {
    const root = await directory("patch-media-read-race-");
    const outside = await directory("patch-media-read-outside-");
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg", "image.png"), png);
    await writeFile(join(outside, "image.png"), png);
    beforeOpen = {
      suffix: join("pkg", "image.png"),
      run: () => replaceWithOutsideLink(root, outside),
    };

    await expect(loadReadOnlyMedia(root, "pkg/image.png")).rejects.toThrow(
      /outside the selected root|changed while opening/u,
    );
  });

  it("does not submit watch comments redirected outside the root", async () => {
    const root = await directory("patch-watch-read-race-");
    const outside = await directory("patch-watch-read-outside-");
    await mkdir(join(root, "pkg"));
    await writeFile(join(root, "pkg", "watched.ts"), "// AI? safe\n");
    await writeFile(join(outside, "watched.ts"), "// AI! injected\n");
    const requests: unknown[] = [];
    const watcher = new AiWatchMode({
      root,
      submit: async (request) => {
        requests.push(request);
      },
    });
    beforeOpen = {
      suffix: join("pkg", "watched.ts"),
      run: () => replaceWithOutsideLink(root, outside),
    };

    watcher.notify("pkg/watched.ts");
    await watcher.flush();

    expect(requests).toEqual([]);
    await watcher.close();
  });

  it("rejects tag extraction redirected by an ancestor swap", async () => {
    const root = await directory("patch-tag-read-race-");
    const outside = await directory("patch-tag-read-outside-");
    await mkdir(join(root, "pkg"));
    await writeFile(
      join(root, "pkg", "source.ts"),
      "export const safeName = 1;\n",
    );
    await writeFile(
      join(outside, "source.ts"),
      "export const injectedName = 2;\n",
    );
    beforeOpen = {
      suffix: join("pkg", "source.ts"),
      run: () => replaceWithOutsideLink(root, outside),
    };

    await expect(
      (await TagExtractor.create(root)).extract("pkg/source.ts"),
    ).rejects.toThrow(/outside the selected root|changed while opening/u);
  });

  it("rejects map rendering redirected by an ancestor swap", async () => {
    const root = await directory("patch-render-read-race-");
    const outside = await directory("patch-render-read-outside-");
    await mkdir(join(root, "pkg"));
    await writeFile(
      join(root, "pkg", "source.ts"),
      "export const safeName = 1;\n",
    );
    await writeFile(
      join(outside, "source.ts"),
      "export const injectedName = 2;\n",
    );
    beforeOpen = {
      suffix: join("pkg", "source.ts"),
      run: () => replaceWithOutsideLink(root, outside),
    };

    await expect(
      (await TreeContextRenderer.create(root)).render(
        "pkg/source.ts",
        new Set([0]),
      ),
    ).rejects.toThrow(/outside the selected root|changed while opening/u);
  });
});
