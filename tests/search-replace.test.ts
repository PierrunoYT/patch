import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import upstream from "../upstream.json" with { type: "json" };
import {
  applySearchReplace,
  SearchReplaceAmbiguousError,
  SearchReplaceEditStrategy,
  SearchReplaceNoMatchError,
  SearchReplaceParseError,
} from "../src/index.js";

interface SearchReplaceFixture {
  parsed: [[string, string, string], [null, string]];
  missingFilenameError: string;
  replacements: Record<string, string>;
}

const fixture = (
  JSON.parse(
    readFileSync(
      new URL(
        `fixtures/upstream/aider-${upstream.commit.slice(0, 8)}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { searchReplace: SearchReplaceFixture }
).searchReplace;

const strategy = new SearchReplaceEditStrategy();
const context = {
  editablePaths: ["example.txt"],
  fence: ["```", "```"] as const,
};

describe("SearchReplaceEditStrategy", () => {
  it("matches the pinned upstream parsed edit and shell block", () => {
    const response = `Here is the change:

\`\`\`text
example.txt
<<<<<<< SEARCH
old value
=======
new value
>>>>>>> REPLACE
\`\`\`

\`\`\`sh
npm test
\`\`\`
`;

    const result = strategy.parse(response, context);

    expect(result).toEqual({
      edits: [
        {
          kind: "replace",
          path: fixture.parsed[0][0],
          search: fixture.parsed[0][1],
          replacement: fixture.parsed[0][2],
        },
      ],
      shellCommands: [fixture.parsed[1][1]],
    });
  });

  it("matches pinned exact, indentation, and ellipsis replacements", () => {
    expect(
      applySearchReplace(
        "before\nold value\nafter\n",
        "old value\n",
        "new value\n",
      ),
    ).toBe(fixture.replacements.exact);
    expect(
      applySearchReplace(
        "    first\n    second\n        nested\n",
        "second\n    nested\n",
        "changed\n    updated\n",
      ),
    ).toBe(fixture.replacements.missingLeadingWhitespace);
    expect(
      applySearchReplace(
        "start\nkeep one\nmiddle\nkeep two\nend\n",
        "start\n...\nend\n",
        "new start\n...\nnew end\n",
      ),
    ).toBe(fixture.replacements.ellipsis);
  });

  it("uses the prior filename and accepts divider-terminated replacement blocks", () => {
    const response = `example.txt
<<<<<<< SEARCH
one
=======
two
>>>>>>> REPLACE
<<<<<<< SEARCH
two
=======
three
=======
`;

    expect(strategy.parse(response, context).edits).toEqual([
      {
        kind: "replace",
        path: "example.txt",
        search: "one\n",
        replacement: "two\n",
      },
      {
        kind: "replace",
        path: "example.txt",
        search: "two\n",
        replacement: "three\n",
      },
    ]);
  });

  it("parses empty SEARCH blocks without misclassifying their fence as shell", () => {
    const response = `\`\`\`sh
script.sh
<<<<<<< SEARCH
=======
echo ready
>>>>>>> REPLACE
\`\`\``;

    expect(
      strategy.parse(response, {
        editablePaths: [],
        fence: ["```", "```"],
      }),
    ).toEqual({
      edits: [
        {
          kind: "replace",
          path: "script.sh",
          search: "",
          replacement: "echo ready\n",
        },
      ],
      shellCommands: [],
    });
    expect(applySearchReplace("existing\n", "", "appended")).toBe(
      "existing\nappended\n",
    );
  });

  it("reports malformed blocks with upstream-compatible context", () => {
    expect(() =>
      strategy.parse(
        "<<<<<<< SEARCH\nold value\n=======\nnew value\n>>>>>>> REPLACE\n",
        context,
      ),
    ).toThrow(fixture.missingFilenameError);
    expect(() =>
      strategy.parse("example.txt\n<<<<<<< SEARCH\nmissing divider", context),
    ).toThrow(SearchReplaceParseError);
    expect(() =>
      applySearchReplace("start\nend\n", "start\n...\nend\n", "changed\n"),
    ).toThrow(SearchReplaceParseError);
  });

  it("rejects absent and ambiguous matches with actionable diagnostics", () => {
    expect(() =>
      applySearchReplace("actual\n", "missing\n", "replacement\n", "a.ts"),
    ).toThrow(/SEARCH block failed to match a\.ts/);
    expect(() =>
      applySearchReplace("actual\n", "missing\n", "replacement\n"),
    ).toThrow(SearchReplaceNoMatchError);
    expect(() =>
      applySearchReplace("same\nsame\n", "same\n", "changed\n"),
    ).toThrow(SearchReplaceAmbiguousError);
    expect(() =>
      applySearchReplace(
        "a\nkeep\nb\na\nkeep\nb\n",
        "a\n...\nb\n",
        "x\n...\ny\n",
      ),
    ).toThrow(SearchReplaceAmbiguousError);
  });
});
