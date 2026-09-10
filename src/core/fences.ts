/*
 * Ported from aider/coders/base_coder.py at
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch: extracted from the coder class as a pure TypeScript function.
 * Licensed under the Apache License, Version 2.0.
 */

export type Fence = readonly [open: string, close: string];

function xmlFence(name: string): Fence {
  return [`<${name}>`, `</${name}>`];
}

export const ALL_FENCES: readonly Fence[] = [
  ["```", "```"],
  ["````", "````"],
  xmlFence("source"),
  xmlFence("code"),
  xmlFence("pre"),
  xmlFence("codeblock"),
  xmlFence("sourcecode"),
];

export interface FenceSelection {
  fence: Fence;
  fellBack: boolean;
}

const ADDITIONAL_LINE_BREAKS = [
  0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
].map((codePoint) => String.fromCodePoint(codePoint));

function lines(content: string): string[] {
  let normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  for (const lineBreak of ADDITIONAL_LINE_BREAKS) {
    normalized = normalized.replaceAll(lineBreak, "\n");
  }
  return normalized.split("\n");
}

export function selectFence(contents: Iterable<string>): FenceSelection {
  const contentLines = Array.from(contents).flatMap(lines);
  const fence = ALL_FENCES.find(
    ([open, close]) =>
      !contentLines.some(
        (line) => line.startsWith(open) || line.startsWith(close),
      ),
  );

  return fence === undefined
    ? { fence: ALL_FENCES[0]!, fellBack: true }
    : { fence, fellBack: false };
}
