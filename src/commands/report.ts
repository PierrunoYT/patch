/**
 * Local report behavior adapted from aider/report.py and aider/commands.py at
 * revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch to render only allowlisted version metadata and a bounded,
 * visibly identified user title. It never opens a browser, uploads, calls a
 * provider, uses the network, or includes diagnostics, paths, source, or chat.
 * Licensed under the Apache License, Version 2.0.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SAFE_VERSION = /^[0-9][0-9A-Za-z.+-]{0,63}$/u;
const SAFE_SYSTEM_LABEL = /^[0-9A-Za-z._+-]{1,64}$/u;

export interface ReportMetadata {
  readonly patchVersion: string;
  readonly nodeVersion: string;
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
  readonly gitVersion?: string;
}

function allowlisted(value: string, pattern: RegExp): string {
  return pattern.test(value) ? value : "unavailable";
}

async function patchVersion(): Promise<string> {
  try {
    const manifest = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { readonly version?: unknown };
    return typeof manifest.version === "string"
      ? allowlisted(manifest.version, SAFE_VERSION)
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Resolve only metadata whose value shape is explicitly accepted below. */
export async function resolveReportMetadata(
  signal?: AbortSignal,
): Promise<ReportMetadata> {
  let gitVersion: string | undefined;
  try {
    const { stdout } = await execFileAsync("git", ["--version"], {
      encoding: "utf8",
      maxBuffer: 256,
      timeout: 2_000,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    });
    const match = /^git version ([0-9][0-9A-Za-z.+-]{0,63})\s*$/u.exec(stdout);
    gitVersion = match?.[1];
  } catch (error) {
    if (signal?.aborted === true) throw error;
  }

  return {
    patchVersion: await patchVersion(),
    nodeVersion: allowlisted(process.versions.node, SAFE_VERSION),
    platform: allowlisted(platform(), SAFE_SYSTEM_LABEL),
    release: allowlisted(release(), SAFE_SYSTEM_LABEL),
    architecture: allowlisted(arch(), SAFE_SYSTEM_LABEL),
    ...(gitVersion === undefined ? {} : { gitVersion }),
  };
}

/**
 * Bounds the title again at the boundary the renderer owns. The parser rejects
 * an oversized or control-bearing title, but this function is exported, so an
 * embedding host calling it directly must not be able to exceed the documented
 * 160 control-free characters either.
 */
function safeTitle(title: string): string {
  const cleaned = title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "�");
  return cleaned.length <= 160 ? cleaned : `${cleaned.slice(0, 159)}…`;
}

/** Render a copyable local draft from the complete and deliberately small allowlist. */
export function renderReport(metadata: ReportMetadata, title?: string): string {
  return [
    "Local issue draft (review before posting)",
    title === undefined
      ? 'Suggested title: "Bug report"'
      : `User-supplied title (review carefully): ${JSON.stringify(safeTitle(title))}`,
    "",
    "Allowlisted version metadata:",
    `- Patch: ${allowlisted(metadata.patchVersion, SAFE_VERSION)}`,
    `- Node.js: ${allowlisted(metadata.nodeVersion, SAFE_VERSION)}`,
    `- OS: ${allowlisted(metadata.platform, SAFE_SYSTEM_LABEL)} ${allowlisted(metadata.release, SAFE_SYSTEM_LABEL)} (${allowlisted(metadata.architecture, SAFE_SYSTEM_LABEL)})`,
    `- Git: ${
      metadata.gitVersion === undefined
        ? "unavailable"
        : allowlisted(metadata.gitVersion, SAFE_VERSION)
    }`,
    "",
    "Describe the problem here, then copy this draft into the issue tracker.",
    "Nothing was uploaded or opened automatically.",
  ].join("\n");
}
