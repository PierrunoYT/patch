import { describe, expect, it } from "vitest";

import { ASK_SYSTEM_PROMPT, AskEditStrategy } from "../src/index.js";

describe("AskEditStrategy", () => {
  it("never emits file edits or shell commands", () => {
    const strategy = new AskEditStrategy();
    const response = `src/index.ts
\`\`\`ts
throw new Error("this must not be applied");
\`\`\`

\`\`\`sh
rm -rf .
\`\`\``;

    expect(
      strategy.parse(response, {
        editablePaths: ["src/index.ts"],
        fence: ["```", "```"],
      }),
    ).toEqual({ edits: [], shellCommands: [] });
    expect(strategy.format).toBe("ask");
  });

  it("instructs the model to analyze rather than edit", () => {
    expect(ASK_SYSTEM_PROMPT).toContain("expert code analyst");
    expect(ASK_SYSTEM_PROMPT).toContain("Do not return full diffs");
    expect(ASK_SYSTEM_PROMPT).not.toContain("SEARCH/REPLACE");
  });
});
