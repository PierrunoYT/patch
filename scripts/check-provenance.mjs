import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_LEDGER = "docs/direct-derivations.json";
const DERIVATION_MARKER = /\b(?:ported|adapted) from [^\n]{0,160}aider\//i;

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

function parseJson(path, label, errors) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return undefined;
  }
}

export function provenanceErrors(
  root = DEFAULT_ROOT,
  ledgerPath = DEFAULT_LEDGER,
) {
  const errors = [];
  const upstream = parseJson(
    join(root, "upstream.json"),
    "upstream.json",
    errors,
  );
  const absoluteLedger = isAbsolute(ledgerPath)
    ? ledgerPath
    : join(root, ledgerPath);
  const ledger = parseJson(absoluteLedger, "provenance ledger", errors);
  if (upstream === undefined || ledger === undefined) return errors;

  if (ledger.schemaVersion !== 1) errors.push("ledger schemaVersion must be 1");
  if (ledger.upstreamRepository !== upstream.repository) {
    errors.push("ledger upstreamRepository does not match upstream.json");
  }
  if (ledger.pinnedRevision !== upstream.commit) {
    errors.push("ledger pinnedRevision does not match upstream.json");
  }
  if (!Array.isArray(ledger.entries)) {
    errors.push("ledger entries must be an array");
    return errors;
  }

  const listed = new Set();
  let previousPath = "";
  for (const [index, entry] of ledger.entries.entries()) {
    const prefix = `entries[${index}]`;
    if (typeof entry?.localPath !== "string") {
      errors.push(`${prefix}.localPath must be a string`);
      continue;
    }
    const localPath = entry.localPath;
    if (listed.has(localPath))
      errors.push(`duplicate ledger entry: ${localPath}`);
    listed.add(localPath);
    if (localPath.localeCompare(previousPath) < 0) {
      errors.push(`ledger entries are not sorted: ${localPath}`);
    }
    previousPath = localPath;
    if (!localPath.startsWith("src/") || localPath.includes("..")) {
      errors.push(`${localPath}: localPath must be contained under src/`);
      continue;
    }
    if (entry.kind !== "source" && entry.kind !== "resource") {
      errors.push(`${localPath}: kind must be source or resource`);
    }
    if (entry.revision !== upstream.commit) {
      errors.push(`${localPath}: revision does not match upstream.json`);
    }
    if (entry.modified !== true) {
      errors.push(`${localPath}: modified must be true`);
    }
    if (entry.license !== upstream.license || entry.license !== "Apache-2.0") {
      errors.push(
        `${localPath}: license must match Apache-2.0 upstream metadata`,
      );
    }
    if (
      !Array.isArray(entry.upstreamPaths) ||
      entry.upstreamPaths.length === 0 ||
      entry.upstreamPaths.some(
        (path) => typeof path !== "string" || !path.startsWith("aider/"),
      )
    ) {
      errors.push(`${localPath}: upstreamPaths must contain Aider paths`);
    }

    const absolutePath = resolve(root, localPath);
    if (!absolutePath.startsWith(`${resolve(root, "src")}${sep}`)) {
      errors.push(`${localPath}: resolves outside src/`);
      continue;
    }
    let content;
    try {
      if (!statSync(absolutePath).isFile()) throw new Error("not a file");
      content = readFileSync(absolutePath, "utf8");
    } catch {
      errors.push(`${localPath}: listed file does not exist`);
      continue;
    }
    if (!content.includes(upstream.commit)) {
      errors.push(`${localPath}: missing full pinned revision`);
    }
    if (!/modified for Patch/i.test(content)) {
      errors.push(`${localPath}: missing modification statement`);
    }
    if (!/Apache License, Version 2\.0/i.test(content)) {
      errors.push(`${localPath}: missing Apache-2.0 attribution`);
    }
    for (const upstreamPath of entry.upstreamPaths ?? []) {
      if (typeof upstreamPath === "string" && !content.includes(upstreamPath)) {
        errors.push(`${localPath}: missing upstream path ${upstreamPath}`);
      }
    }
  }

  for (const absolutePath of sourceFiles(join(root, "src"))) {
    const content = readFileSync(absolutePath, "utf8");
    if (DERIVATION_MARKER.test(content)) {
      const localPath = relative(root, absolutePath).split(sep).join("/");
      if (!listed.has(localPath)) {
        errors.push(
          `${localPath}: direct Aider derivation is absent from ledger`,
        );
      }
    }
  }

  const notice = readFileSync(join(root, "NOTICE"), "utf8");
  if (!notice.includes(upstream.commit) || !notice.includes("Apache")) {
    errors.push("NOTICE lacks the pinned revision or Apache attribution");
  }
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  if (!license.includes("Apache License") || !license.includes("Version 2.0")) {
    errors.push("LICENSE is not the Apache License, Version 2.0");
  }
  return errors;
}

function main() {
  const ledgerFlag = process.argv.indexOf("--ledger");
  const ledgerPath =
    ledgerFlag === -1 ? DEFAULT_LEDGER : process.argv[ledgerFlag + 1];
  if (ledgerPath === undefined) {
    throw new Error("--ledger requires a path");
  }
  const errors = provenanceErrors(DEFAULT_ROOT, ledgerPath);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  const ledger = JSON.parse(
    readFileSync(
      isAbsolute(ledgerPath) ? ledgerPath : join(DEFAULT_ROOT, ledgerPath),
      "utf8",
    ),
  );
  process.stdout.write(
    `Verified ${ledger.entries.length} direct derivations.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
