import { describe, expect, it } from "vitest";

import { ModelCatalog, selectModels } from "../src/index.js";

describe("selectModels", () => {
  it("resolves configured weak and editor roles exactly once", async () => {
    const catalog = await ModelCatalog.load();

    const selected = selectModels(catalog, { main: "sonnet" });

    expect(selected.main.canonicalName).toBe("claude-sonnet-4-6");
    expect(selected.weak.canonicalName).toBe("claude-haiku-4-5");
    expect(selected.editor).toBe(selected.main);
    expect(selected.editorEditFormat).toBe("diff");
  });

  it("supports disabled roles and explicit overrides without recursion", async () => {
    const catalog = await ModelCatalog.load();

    const selected = selectModels(catalog, {
      main: "4o",
      weak: false,
      editor: "deepseek",
      editorEditFormat: "whole",
    });

    expect(selected.weak).toBe(selected.main);
    expect(selected.editor.canonicalName).toBe("deepseek/deepseek-chat");
    expect(selected.editorEditFormat).toBe("whole");
  });
});
