import { describe, expect, it } from "vitest";

import {
  highlightSyntax,
  MarkdownStream,
  renderCommandResult,
  renderDiff,
  renderEditPreview,
  renderUsage,
  stripAnsi,
} from "../src/io/render.js";

describe("terminal rendering", () => {
  it("streams markdown correctly across arbitrary chunk boundaries", () => {
    let output = "";
    const stream = new MarkdownStream((chunk) => (output += chunk), {
      color: true,
    });
    stream.write("# Ti");
    stream.write("tle\nText with `co");
    stream.write('de`.\n```ts\nconst value = "x";\n```\n');
    stream.end();

    expect(stripAnsi(output)).toBe(
      'Title\nText with code.\nconst value = "x";\n',
    );
    expect(output).toContain("\u001b[1mTitle");
    expect(output).toContain("\u001b[36mconst");
  });

  it("highlights supported syntax without interpreting hostile input escapes", () => {
    const rendered = highlightSyntax(
      'const secret = "x";\u001b]2;owned\u0007',
      "ts",
      {
        color: true,
      },
    );
    expect(rendered).toContain("\u001b[36mconst");
    expect(rendered).not.toContain("]2;owned");
  });

  it("renders asymmetric diff lines and honors explicit or environmental no-color", () => {
    const diff = "--- a/file\n+++ b/file\n-old\n+new\n@@ -1 +1 @@\n same";
    const colored = renderDiff(diff, { color: true });
    expect(colored).toContain("\u001b[31m-old");
    expect(colored).toContain("\u001b[32m+new");
    expect(renderDiff(diff, { color: false })).toBe(diff);
    expect(
      renderDiff(diff, { environment: { NO_COLOR: "1" }, isTTY: true }),
    ).toBe(diff);
  });

  it("turns resolved operations into a reviewable diff preview", () => {
    expect(
      renderEditPreview({
        changedPaths: ["src/example.ts"],
        operations: [
          {
            kind: "update",
            path: "src/example.ts",
            before: "const oldValue = 1;",
            content: "const newValue = 2;",
          },
        ],
      }),
    ).toBe(
      "--- a/src/example.ts\n+++ b/src/example.ts\n@@ proposed edit @@\n-const oldValue = 1;\n+const newValue = 2;",
    );
  });

  it("reports tokens and cost, and omits a cost it does not know", () => {
    expect(
      renderUsage(
        {
          inputTokens: 1500,
          outputTokens: 320,
          cachedInputTokens: 900,
          cost: 0.0042,
          costSource: "catalog",
        },
        0.31,
        { color: false },
      ),
      // Sub-cent turn costs need more than two decimals to mean anything.
    ).toBe(
      "tokens: 1.5k sent, 900 cached, 320 received · $0.0042 turn, $0.31 session",
    );

    // An unpriced model reports tokens rather than implying a cost of zero.
    expect(
      renderUsage(
        {
          inputTokens: 12,
          outputTokens: 4,
          cost: null,
          costSource: "unknown",
        },
        undefined,
        { color: false },
      ),
    ).toBe("tokens: 12 sent, 4 received");
  });

  it("shows both command streams, the status, and truncation", () => {
    expect(
      renderCommandResult(
        {
          command: "npm test",
          status: "completed",
          exitCode: 1,
          stdout: "ran 3 tests\n",
          stderr: "one failed\n",
          truncated: true,
        },
        { color: false },
      ),
    ).toBe(
      "$ npm test — exit 1, output truncated\nran 3 tests\nstderr:\none failed",
    );

    // A command that only wrote to stderr must not look like it said nothing.
    expect(
      renderCommandResult(
        {
          command: "false",
          status: "completed",
          exitCode: 2,
          stdout: "",
          stderr: "boom",
          truncated: false,
        },
        { color: false },
      ),
    ).toBe("$ false — exit 2\nstderr:\nboom");

    // Denial, timeout, and cancellation are stated, not implied by silence.
    expect(
      renderCommandResult(
        {
          command: "rm -rf /",
          status: "denied",
          exitCode: null,
          stdout: "",
          stderr: "",
          truncated: false,
        },
        { color: false },
      ),
    ).toBe("$ rm -rf / — denied");

    // Child output is untrusted and cannot drive the terminal.
    expect(
      renderCommandResult(
        {
          command: "greet\u001b[2J",
          status: "completed",
          exitCode: 0,
          stdout: "hi\u001b]2;owned\u0007",
          stderr: "",
          truncated: false,
        },
        { color: false },
      ),
    ).toBe("$ greet — exit 0\nhi");
  });
});
