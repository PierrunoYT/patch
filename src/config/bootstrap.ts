/**
 * Startup sequencing adapted from aider/main.py and aider/args.py at
 * revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch's TypeScript, Node.js, npm, and PATCH_* configuration.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";

import { parse as parseDotenv } from "dotenv";

import { TextEncodingSchema, type TextEncoding } from "../io/filesystem.js";

const executeFile = promisify(execFile);
const CONFIG_FILE_NAME = ".patch.conf.yml";
const DOTENV_FILE_NAME = ".env";

export type BootstrapEnvironment = Readonly<Record<string, string | undefined>>;

export interface BootstrapArguments {
  readonly configFile: string | undefined;
  readonly envFile: string | undefined;
  readonly encoding: TextEncoding;
  readonly git: boolean;
  readonly model: string | undefined;
  readonly files: readonly string[];
}

export interface ConfigurationBootstrap {
  readonly initialGitRoot: string | undefined;
  readonly gitRoot: string | undefined;
  readonly rootCorrected: boolean;
  readonly arguments: BootstrapArguments;
  readonly configSearchPaths: readonly string[];
  readonly configFiles: readonly string[];
  readonly dotenvSearchPaths: readonly string[];
  readonly dotenvFiles: readonly string[];
  /** A private copy for later provider/config resolution. Never log this value. */
  readonly environment: BootstrapEnvironment;
}

export interface BootstrapOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly home?: string;
  readonly environment?: BootstrapEnvironment;
}

interface ParsedCommandLine {
  configFile: string | undefined;
  envFile: string | undefined;
  encoding: string | undefined;
  git: boolean | undefined;
  model: string | undefined;
  files: string[];
}

interface BootstrapPass {
  rootForSearch: string | undefined;
  arguments: BootstrapArguments;
  configSearchPaths: string[];
  configFiles: string[];
  dotenvSearchPaths: string[];
  dotenvFiles: string[];
  environment: Record<string, string | undefined>;
}

export class BootstrapArgumentError extends Error {
  override readonly name = "BootstrapArgumentError";
}

export class RepositorySelectionError extends Error {
  override readonly name = "RepositorySelectionError";
}

function optionValue(
  argv: readonly string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const argument = argv[index];
  const equals = argument?.indexOf("=") ?? -1;
  if (equals >= 0) {
    const value = argument?.slice(equals + 1) ?? "";
    if (value.length === 0) {
      throw new BootstrapArgumentError(`${option} requires a value`);
    }
    return { value, nextIndex: index };
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new BootstrapArgumentError(`${option} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function parseCommandLine(
  argv: readonly string[],
  allowUnknownOptions: boolean,
): ParsedCommandLine {
  const parsed: ParsedCommandLine = {
    configFile: undefined,
    envFile: undefined,
    encoding: undefined,
    git: undefined,
    model: undefined,
    files: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      parsed.files.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "--git") {
      parsed.git = true;
      continue;
    }
    if (argument === "--no-git") {
      parsed.git = false;
      continue;
    }

    const option = argument?.split("=", 1)[0];
    const target =
      option === "--config" || option === "-c"
        ? "configFile"
        : option === "--env-file"
          ? "envFile"
          : option === "--encoding"
            ? "encoding"
            : option === "--model"
              ? "model"
              : option === "--file"
                ? "file"
                : undefined;
    if (target !== undefined) {
      const result = optionValue(argv, index, option ?? "option");
      index = result.nextIndex;
      if (target === "file") {
        parsed.files.push(result.value);
      } else {
        parsed[target] = result.value;
      }
      continue;
    }

    if (argument?.startsWith("-c") && argument.length > 2) {
      parsed.configFile = argument.slice(2);
      continue;
    }
    if (argument?.startsWith("-")) {
      if (allowUnknownOptions) {
        continue;
      }
      throw new BootstrapArgumentError(`Unknown option: ${argument}`);
    }
    if (argument !== undefined) {
      parsed.files.push(argument);
    }
  }

  return parsed;
}

function environmentBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new BootstrapArgumentError(
    `${name} must be true/false, yes/no, on/off, or 1/0`,
  );
}

function resolveArguments(
  commandLine: ParsedCommandLine,
  environment: BootstrapEnvironment,
): BootstrapArguments {
  const encodingValue =
    commandLine.encoding ?? environment.PATCH_ENCODING ?? "utf-8";
  const encoding = TextEncodingSchema.safeParse(encodingValue);
  if (!encoding.success) {
    throw new BootstrapArgumentError(
      `Unsupported text encoding: ${encodingValue}`,
    );
  }

  return {
    configFile: commandLine.configFile ?? environment.PATCH_CONFIG,
    envFile: commandLine.envFile ?? environment.PATCH_ENV_FILE,
    encoding: encoding.data,
    git:
      commandLine.git ??
      environmentBoolean(environment.PATCH_GIT, "PATCH_GIT") ??
      true,
    model: commandLine.model ?? environment.PATCH_MODEL,
    files: [...commandLine.files],
  };
}

async function uniquePaths(
  paths: readonly (string | undefined)[],
): Promise<string[]> {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (path === undefined) {
      continue;
    }
    let canonical = path;
    try {
      canonical = await realpath(path);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

async function existingFiles(paths: readonly string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const path of paths) {
    try {
      await access(path, constants.R_OK);
      if ((await stat(path)).isFile()) {
        existing.push(path);
      }
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
  }
  return existing;
}

async function canonicalDirectory(path: string): Promise<string> {
  return realpath(path);
}

export async function discoverGitRoot(
  startPath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await executeFile(
      "git",
      ["-C", startPath, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    const root = stdout.trim();
    return root === "" ? undefined : canonicalDirectory(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error("Git is required for repository discovery", {
        cause: error,
      });
    }
    return undefined;
  }
}

async function nearestExistingDirectory(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      const information = await stat(candidate);
      const canonical = await realpath(candidate);
      return information.isDirectory() ? canonical : dirname(canonical);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      return parse(candidate).root;
    }
    candidate = parent;
  }
}

async function discoverSelectedRoot(
  files: readonly string[],
  cwd: string,
): Promise<string | undefined> {
  if (files.length === 0) {
    return undefined;
  }

  const roots = new Set<string>();
  let pathsWithoutRoot = 0;
  for (const file of files) {
    const directory = await nearestExistingDirectory(resolve(cwd, file));
    const root = await discoverGitRoot(directory);
    if (root === undefined) {
      pathsWithoutRoot += 1;
    } else {
      roots.add(root);
    }
  }

  if (roots.size > 1 || (roots.size === 1 && pathsWithoutRoot > 0)) {
    throw new RepositorySelectionError(
      "Selected files do not belong to one Git repository",
    );
  }
  return roots.values().next().value;
}

function decodeDotenv(
  bytes: Buffer,
  encoding: TextEncoding,
  path: string,
): string {
  try {
    return encoding === "latin1"
      ? bytes.toString("latin1")
      : new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`Unable to decode dotenv file ${path} as ${encoding}`, {
      cause: error,
    });
  }
}

async function runBootstrapPass(
  argv: readonly string[],
  cwd: string,
  home: string,
  baseEnvironment: BootstrapEnvironment,
  discoverFromCwd: boolean,
  suppliedRoot: string | undefined,
): Promise<BootstrapPass> {
  const preliminaryCommandLine = parseCommandLine(argv, true);
  const preliminaryArguments = resolveArguments(
    preliminaryCommandLine,
    baseEnvironment,
  );
  const rootForSearch = discoverFromCwd
    ? await discoverGitRoot(cwd)
    : suppliedRoot;

  const configSearchPaths = await uniquePaths([
    join(home, CONFIG_FILE_NAME),
    rootForSearch === undefined
      ? undefined
      : join(rootForSearch, CONFIG_FILE_NAME),
    join(cwd, CONFIG_FILE_NAME),
    preliminaryArguments.configFile === undefined
      ? undefined
      : resolve(cwd, preliminaryArguments.configFile),
  ]);
  const configFiles = await existingFiles(configSearchPaths);

  const dotenvSearchPaths = await uniquePaths([
    join(home, DOTENV_FILE_NAME),
    rootForSearch === undefined
      ? undefined
      : join(rootForSearch, DOTENV_FILE_NAME),
    join(cwd, DOTENV_FILE_NAME),
    preliminaryArguments.envFile === undefined
      ? undefined
      : resolve(cwd, preliminaryArguments.envFile),
  ]);
  const dotenvFiles = await existingFiles(dotenvSearchPaths);
  const environment: Record<string, string | undefined> = {
    ...baseEnvironment,
  };
  for (const path of dotenvFiles) {
    const content = decodeDotenv(
      await readFile(path),
      preliminaryArguments.encoding,
      path,
    );
    Object.assign(environment, parseDotenv(content));
  }

  const finalCommandLine = parseCommandLine(argv, false);

  return {
    rootForSearch,
    arguments: resolveArguments(finalCommandLine, environment),
    configSearchPaths,
    configFiles,
    dotenvSearchPaths,
    dotenvFiles,
    environment,
  };
}

export async function bootstrapConfiguration(
  options: BootstrapOptions = {},
): Promise<ConfigurationBootstrap> {
  const argv = options.argv ?? [];
  const cwd = await canonicalDirectory(options.cwd ?? process.cwd());
  const home = await canonicalDirectory(options.home ?? homedir());
  const baseEnvironment = { ...(options.environment ?? process.env) };
  const first = await runBootstrapPass(
    argv,
    cwd,
    home,
    baseEnvironment,
    true,
    undefined,
  );

  let selectedRoot = first.rootForSearch;
  if (first.arguments.git && first.arguments.files.length > 0) {
    selectedRoot = await discoverSelectedRoot(first.arguments.files, cwd);
  }

  const rootCorrected =
    first.arguments.git && selectedRoot !== first.rootForSearch;
  const final = rootCorrected
    ? await runBootstrapPass(
        argv,
        cwd,
        home,
        baseEnvironment,
        false,
        selectedRoot,
      )
    : first;

  return {
    initialGitRoot: first.rootForSearch,
    gitRoot: final.arguments.git ? selectedRoot : undefined,
    rootCorrected,
    arguments: final.arguments,
    configSearchPaths: final.configSearchPaths,
    configFiles: final.configFiles,
    dotenvSearchPaths: final.dotenvSearchPaths,
    dotenvFiles: final.dotenvFiles,
    environment: Object.freeze({ ...final.environment }),
  };
}
