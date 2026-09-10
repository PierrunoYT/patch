import { describe, expect, it } from "vitest";

import {
  ControlSequenceSanitizer,
  MarkdownStream,
  renderDiff,
  renderEditPreview,
  sanitizedWriter,
  sanitizeTerminalText,
} from "../src/index.js";

const ESCAPE = "\u001b";
const BELL = "\u0007";
const CSI8 = "\u009b";
const OSC8 = "\u009d";
const ST8 = "\u009c";
const APC8 = "\u009f";
const DEL = "\u007f";
const C1 = "\u0086";
const NUL = "\u0000";

describe("control sequence sanitizer", () => {
  it.each([
    ["CSI erase and colour", `red${ESCAPE}[2J${ESCAPE}[31mtext`, "redtext"],
    ["8-bit CSI", `red${CSI8}2Jtext`, "redtext"],
    ["OSC terminated by BEL", `a${ESCAPE}]0;owned${BELL}b`, "ab"],
    ["OSC terminated by ST", `a${ESCAPE}]0;owned${ESCAPE}\\b`, "ab"],
    ["OSC terminated by 8-bit ST", `a${ESCAPE}]0;owned${ST8}b`, "ab"],
    ["8-bit OSC", `a${OSC8}0;owned${ST8}b`, "ab"],
    ["DCS string", `a${ESCAPE}Ppayload${ESCAPE}\\b`, "ab"],
    ["APC string", `a${ESCAPE}_payload${ESCAPE}\\b`, "ab"],
    ["PM string", `a${ESCAPE}^payload${ESCAPE}\\b`, "ab"],
    ["SOS string", `a${ESCAPE}Xpayload${ESCAPE}\\b`, "ab"],
    ["8-bit APC string", `a${APC8}payload${ST8}b`, "ab"],
    ["two-character escape", `a${ESCAPE}7b`, "ab"],
    ["single shift", `a${ESCAPE}Nxb`, "axb"],
    ["charset selection with intermediates", `a${ESCAPE}(Bb`, "ab"],
    ["reset with intermediate", `a${ESCAPE}#8b`, "ab"],
    ["bare C0 controls", `a${NUL} ${BELL}b`, "a b"],
    ["DEL", `a${DEL}b`, "ab"],
    ["bare C1 controls", `a${C1}b`, "ab"],
  ])("removes %s", (_name, hostile, expected) => {
    expect(sanitizeTerminalText(hostile)).toBe(expected);
  });

  it("keeps text, layout whitespace, and non-ASCII content", () => {
    const text = "line one\n\tindented\r\nkeep é 漢字 \u{1f642}\n";
    expect(sanitizeTerminalText(text)).toBe(text);
  });

  it("removes a sequence split across chunk boundaries", () => {
    const sanitizer = new ControlSequenceSanitizer();
    const chunks = ["safe", ESCAPE, "]2;ow", `ned${BELL}${ESCAPE}[2`, "Jdone"];
    expect(chunks.map((chunk) => sanitizer.write(chunk)).join("")).toBe(
      "safedone",
    );
  });

  it("keeps one sanitizer state across writes through a wrapped writer", () => {
    let written = "";
    const write = sanitizedWriter((text) => (written += text));
    write(`visible${ESCAPE}`);
    write("[31mstill visible");
    expect(written).toBe("visiblestill visible");
  });

  it("never emits an empty write", () => {
    const writes: string[] = [];
    const write = sanitizedWriter((text) => writes.push(text));
    write(ESCAPE);
    write("[0m");
    expect(writes).toEqual([]);
  });
});

describe("untrusted terminal output paths", () => {
  it("sanitizes streamed model text across delta boundaries", () => {
    let output = "";
    const stream = new MarkdownStream((chunk) => (output += chunk), {
      color: false,
    });
    // A provider can split a hostile sequence over deltas; a per-chunk strip
    // would let the halves rejoin in the terminal.
    stream.write("answer: ");
    stream.write(ESCAPE);
    stream.write("]0;owned");
    stream.write(BELL);
    stream.write(`plain${ESCAPE}[2`);
    stream.write("J done\n");
    stream.end();

    expect(output).toBe("answer: plain done\n");
  });

  it("sanitizes hostile file content shown in an edit preview", () => {
    const rendered = renderDiff(
      renderEditPreview({
        changedPaths: ["notes.txt"],
        operations: [
          {
            kind: "update",
            path: "notes.txt",
            before: `before${ESCAPE}]0;owned${BELL}`,
            content: `after${ESCAPE}[2J`,
          },
        ],
      }),
      { color: false },
    );

    expect(rendered).toContain("-before");
    expect(rendered).toContain("+after");
    expect(rendered).not.toContain(ESCAPE);
    expect(rendered).not.toContain(BELL);
  });
});
