import { describe, expect, it } from "vitest";

import { renderSettings } from "../src/index.js";

describe("settings rendering", () => {
  it("renders only the explicit safe fields and bounds display labels", () => {
    const output = renderSettings({
      currentModel: `model\u001b${"x".repeat(300)}`,
      currentMode: "ask",
      encoding: "utf-8",
      git: true,
      gitCommitVerify: false,
      generateCommitMessages: false,
      lintConfigured: true,
      testConfigured: false,
      rootCorrected: false,
    });

    expect(output).toContain("Model: model�");
    expect(output).not.toContain("\u001b");
    expect(output).toContain("Git: enabled");
    expect(output).toContain("Lint command: configured");
    expect(output.length).toBeLessThan(1000);
  });
  it("neutralizes separators that would forge another settings row", () => {
    const output = renderSettings({
      currentModel: `model\u2028Git: disabled`,
      currentMode: "ask",
      encoding: "utf-8",
      git: true,
      gitCommitVerify: false,
      generateCommitMessages: false,
      lintConfigured: true,
      testConfigured: false,
      rootCorrected: false,
    });

    // U+2028 is a separator rather than a control, but any consumer splitting
    // on Unicode line breaks would read the tail as its own row.
    expect(output).not.toContain("\u2028");
    expect(output).toContain("Git: enabled");
    expect(
      output
        .split(/[\u2028\u2029\n]/u)
        .filter((line) => line.startsWith("Git: ")),
    ).toHaveLength(1);
  });
});
