import { describe, expect, it } from "vitest";

import { renderReport } from "../src/index.js";

describe("local report draft", () => {
  it("rejects malformed metadata values instead of rendering raw diagnostics", () => {
    const secret = "raw-diagnostic-secret-7812";
    const output = renderReport(
      {
        patchVersion: `0.0.0\n${secret}`,
        nodeVersion: "22.1.0",
        platform: `/tmp/private/${secret}`,
        release: "x".repeat(1_000),
        architecture: "x64\u001b]8;;https://example.invalid\u0007",
        gitVersion: `2.51.0 ${secret}`,
      },
      "Visible title",
    );

    expect(output).toContain(
      'User-supplied title (review carefully): "Visible title"',
    );
    expect(output.match(/unavailable/gu)).toHaveLength(5);
    expect(output).not.toContain(secret);
    expect(output.length).toBeLessThan(1_000);
  });
});
