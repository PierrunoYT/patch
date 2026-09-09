/**
 * Ported from aider/coders/patch_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified to produce immutable generic edits and expose accumulated fuzz.
 */

import type { FileSnapshot } from "./resolve.js";
import type { EditStrategy, EditStrategyContext } from "./strategy.js";
import type { Edit, EditBatch } from "./types.js";

export class PatchParseError extends Error {
  override readonly name = "PatchParseError";
}

function findContext(
  lines: readonly string[],
  context: readonly string[],
  start: number,
  eof = false,
): [number, number] {
  for (const [normalize, fuzz] of [
    [(line: string) => line, 0],
    [(line: string) => line.trimEnd(), 1],
    [(line: string) => line.trim(), 100],
  ] as const) {
    const first = eof ? Math.max(start, lines.length - context.length) : start;
    for (
      let index = first;
      index <= lines.length - context.length;
      index += 1
    ) {
      if (
        context.every(
          (line, offset) =>
            normalize(lines[index + offset] ?? "") === normalize(line),
        )
      ) {
        return [index, fuzz];
      }
    }
  }
  if (eof) {
    const [index, fuzz] = findContext(lines, context, start);
    return [index, index < 0 ? fuzz : fuzz + 10_000];
  }
  return [-1, 0];
}

function snapshots(
  files: readonly FileSnapshot[] | undefined,
): Map<string, string | null> {
  return new Map((files ?? []).map((file) => [file.path, file.content]));
}

export class PatchEditStrategy implements EditStrategy {
  readonly format = "patch" as const;

  parse(response: string, context: EditStrategyContext): EditBatch {
    const lines = response.split(/\r?\n/u);
    const contents = snapshots(context.files);
    const edits: Edit[] = [];
    let fuzz = 0;
    let index = lines[0]?.trim() === "*** Begin Patch" ? 1 : 0;
    while (index < lines.length) {
      const header = lines[index] ?? "";
      if (header === "*** End Patch") break;
      if (header.trim() === "") {
        index += 1;
        continue;
      }
      if (header.startsWith("*** Add File: ")) {
        const path = header.slice(14).trim();
        const added: string[] = [];
        index += 1;
        while (
          index < lines.length &&
          !(lines[index] ?? "").startsWith("*** ")
        ) {
          const line = lines[index] ?? "";
          if (!line.startsWith("+"))
            throw new PatchParseError(`Invalid Add File line: ${line}`);
          added.push(line.slice(1));
          index += 1;
        }
        edits.push({ kind: "create", path, content: `${added.join("\n")}\n` });
        continue;
      }
      if (header.startsWith("*** Delete File: ")) {
        edits.push({ kind: "delete", path: header.slice(17).trim() });
        index += 1;
        continue;
      }
      if (!header.startsWith("*** Update File: "))
        throw new PatchParseError(`Unknown patch line: ${header}`);
      const fromPath = header.slice(17).trim();
      const original = contents.get(fromPath);
      if (original === undefined || original === null)
        throw new PatchParseError(`Missing file content for ${fromPath}`);
      let movePath: string | undefined;
      index += 1;
      if ((lines[index] ?? "").startsWith("*** Move to: ")) {
        movePath = (lines[index] ?? "").slice(13).trim();
        index += 1;
      }
      const source = original.split(/\r?\n/u);
      if (source.at(-1) === "") source.pop();
      let cursor = 0;
      const output = [...source];
      let delta = 0;
      while (index < lines.length && !(lines[index] ?? "").startsWith("*** ")) {
        if ((lines[index] ?? "").startsWith("@@")) index += 1;
        const before: string[] = [];
        const after: string[] = [];
        while (
          index < lines.length &&
          !(lines[index] ?? "").startsWith("@@") &&
          !(lines[index] ?? "").startsWith("*** ")
        ) {
          const line = lines[index] ?? "";
          if (![" ", "+", "-"].includes(line[0] ?? ""))
            throw new PatchParseError(`Invalid update line: ${line}`);
          if (line[0] !== "+") before.push(line.slice(1));
          if (line[0] !== "-") after.push(line.slice(1));
          index += 1;
        }
        const eof = lines[index] === "*** End of File";
        if (eof) index += 1;
        const [found, sectionFuzz] = findContext(source, before, cursor, eof);
        if (found < 0)
          throw new PatchParseError(
            `Could not find patch context in ${fromPath}:\n${before.join("\n")}`,
          );
        fuzz += sectionFuzz;
        output.splice(found + delta, before.length, ...after);
        delta += after.length - before.length;
        cursor = found + before.length;
      }
      const content = `${output.join("\n")}\n`;
      edits.push(
        movePath === undefined
          ? { kind: "rewrite", path: fromPath, content }
          : { kind: "move", fromPath, path: movePath, content },
      );
    }
    return { edits, shellCommands: [], fuzz };
  }
}
