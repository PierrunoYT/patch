import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AiWatchMode,
  SerialTaskQueue,
  parseWatchComments,
  type WatchRequest,
} from "../src/index.js";

const roots: string[] = [];
async function root() {
  const result = await mkdtemp(join(tmpdir(), "patch-watch-"));
  roots.push(result);
  return result;
}
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
);

describe("AI watch mode", () => {
  it("parses comment markers and gives AI! edit precedence over AI?", () => {
    expect(
      parseWatchComments("const x = 1; // AI? why?\n# AI! rename x"),
    ).toEqual({
      comments: [
        { line: 1, text: "// AI? why?" },
        { line: 2, text: "# AI! rename x" },
      ],
      action: "edit",
    });
  });

  it("debounces changes and skips ignored, oversized, and escaping files", async () => {
    const directory = await root();
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "good.ts"), "// AI? explain this\n");
    await writeFile(join(directory, "ignored.ts"), "// AI! ignored\n");
    await writeFile(join(directory, "large.ts"), `// AI! ${"x".repeat(100)}\n`);
    await writeFile(
      join(directory, "node_modules", "dep.ts"),
      "// AI! dependency\n",
    );
    const requests: WatchRequest[] = [];
    const watcher = new AiWatchMode({
      root: directory,
      maxFileBytes: 50,
      isIgnored: (path) => path === "ignored.ts",
      submit: async (request) => {
        requests.push(request);
      },
    });
    watcher.notify("good.ts");
    watcher.notify("good.ts");
    watcher.notify("ignored.ts");
    watcher.notify("large.ts");
    watcher.notify("node_modules/dep.ts");
    watcher.notify("../outside.ts");
    await watcher.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ action: "ask", paths: ["good.ts"] });
    watcher.close();
  });

  it("serializes watch submissions behind active model work and cancels queued work", async () => {
    const directory = await root();
    await writeFile(join(directory, "one.ts"), "// AI! first\n");
    await writeFile(join(directory, "two.ts"), "// AI! second\n");
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    let release!: () => void;
    const active = queue.run(async () => {
      order.push("active-start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("active-end");
    });
    const watcher = new AiWatchMode({
      root: directory,
      queue,
      submit: async ({ paths }) => {
        order.push(paths[0] ?? "missing");
      },
    });
    watcher.notify("one.ts");
    const flushing = watcher.flush();
    await Promise.resolve();
    expect(order).toEqual(["active-start"]);
    release();
    await active;
    await flushing;
    expect(order).toEqual(["active-start", "active-end", "one.ts"]);

    watcher.notify("two.ts");
    watcher.close();
    await queue.idle();
    expect(order).not.toContain("two.ts");
  });
});
