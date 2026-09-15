import { describe, expect, it } from "vitest";

import { renderTokenContext } from "../src/index.js";

describe("renderTokenContext", () => {
  it("bounds labels and identifies conservative estimates without optional metadata", () => {
    const output = renderTokenContext({
      model: `unsafe\u001bmodel${"x".repeat(300)}`,
      rows: [{ section: "chat history", tokens: 12.9 }],
      total: { tokens: 13, method: "conservative" },
    });

    expect(output).not.toContain("\u001b");
    expect(output).toContain("unsafe�model");
    expect(output).toContain("13  baseline tokens total");
    expect(output).toContain("Counting: conservative estimate.");
    expect(output).not.toContain("estimated input cost");
    expect(output).not.toContain("maximum input tokens");
    expect(Buffer.byteLength(output)).toBeLessThan(2048);
  });
});
