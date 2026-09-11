/**
 * Local help behavior adapted from aider/help.py and aider/commands.py at
 * revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to search only bundled, allowlisted documentation without
 * constructing a help coder, calling a provider, downloading embeddings, or
 * using the network.
 * Licensed under the Apache License, Version 2.0.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMAND_NAMES } from "./parse.js";

const DOCUMENT_ROOT = fileURLToPath(new URL("../../docs", import.meta.url));
const MAX_RESULTS = 8;
const MAX_EXCERPT_LENGTH = 240;

/** Files intentionally exposed to local help search. */
export const HELP_DOCUMENTS: readonly string[] = [
  "commands.md",
  "configuration-bootstrap.md",
  "filesystem-safety.md",
  "terminal.md",
  "turn-lifecycle.md",
  "url-fetching.md",
];

export interface HelpOptions {
  /** Test/package override; production always uses the installed docs folder. */
  readonly documentRoot?: string;
}

function excerpt(line: string): string {
  const compact = line.trim().replace(/\s+/gu, " ");
  return compact.length <= MAX_EXCERPT_LENGTH
    ? compact
    : `${compact.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

export async function renderHelp(
  query?: string,
  options: HelpOptions = {},
): Promise<string> {
  if (query === undefined) {
    return [
      "Supported commands:",
      ...COMMAND_NAMES.map((name) => `/${name}`),
      "",
      "Use /help <query> to search installed Patch documentation.",
    ].join("\n");
  }

  const needle = query.toLocaleLowerCase("en-US");
  const matches: string[] = [];
  let readableDocuments = 0;
  for (const document of HELP_DOCUMENTS) {
    let content: string;
    try {
      content = await readFile(
        join(options.documentRoot ?? DOCUMENT_ROOT, document),
        "utf8",
      );
      readableDocuments += 1;
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.toLocaleLowerCase("en-US").includes(needle)) continue;
      matches.push(`${document}:${index + 1}: ${excerpt(line)}`);
      if (matches.length === MAX_RESULTS) break;
    }
    if (matches.length === MAX_RESULTS) break;
  }

  if (readableDocuments === 0) {
    return "Patch help documents are unavailable in this installation.";
  }
  if (matches.length === 0) {
    return `No installed Patch help matched: ${query}`;
  }
  return [`Installed Patch help for: ${query}`, ...matches].join("\n");
}
