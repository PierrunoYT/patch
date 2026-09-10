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
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  ApplicationEditFormatSchema,
  type ApplicationEditFormat,
} from "../edits/types.js";
import { TextEncodingSchema, type TextEncoding } from "../io/filesystem.js";

const executeFile = promisify(execFile);
const CONFIG_FILE_NAME = ".patch.conf.yml";
const DOTENV_FILE_NAME = ".env";

const ConfigurationFileSchema = z
  .object({
    model: z.string().min(1).optional(),
    encoding: TextEncodingSchema.optional(),
    git: z.boolean().optional(),
    "env-file": z.string().min(1).optional(),
    "lint-cmd": z.string().trim().min(1).optional(),
    "test-cmd": z.string().trim().min(1).optional(),
    "edit-format": ApplicationEditFormatSchema.optional(),
    files: z.array(z.string().min(1)).optional(),
    "read-only": z.array(z.string().min(1)).optional(),
  })
  .strict();

type ConfigurationFile = z.infer<typeof ConfigurationFileSchema>;

export type BootstrapEnvironment = Readonly<Record<string, string | undefined>>;

export interface BootstrapArguments {
  readonly configFile: string | undefined;
  readonly envFile: string | undefined;
  readonly encoding: TextEncoding;
  readonly git: boolean;
  readonly model: string | undefined;
  readonly lintCommand: string | undefined;
  readonly testCommand: string | undefined;
  readonly editFormat: ApplicationEditFormat | undefined;
  readonly files: readonly string[];
  readonly readOnlyFiles: readonly string[];
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
  lintCommand: string | undefined;
  testCommand: string | undefined;
  editFormat: string | undefined;
  files: string[];
  readOnlyFiles: string[];
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

export class ConfigurationFileError extends Error {
  override readonly name = "ConfigurationFileError";
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(`Invalid configuration file: ${path}`, { cause });
    this.path = path;
  }
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
    lintCommand: undefined,
    testCommand: undefined,
    editFormat: undefined,
    files: [],
    readOnlyFiles: [],
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
              : option === "--lint-cmd"
                ? "lintCommand"
                : option === "--test-cmd"
                  ? "testCommand"
                  : option === "--edit-format"
                    ? "editFormat"
                    : option === "--file"
                      ? "file"
                      : option === "--read-only"
                        ? "readOnlyFile"
                        : undefined;
    if (target !== undefined) {
      const result = optionValue(argv, index, option ?? "option");
      index = result.nextIndex;
      if (target === "file") {
        parsed.files.push(result.value);
      } else if (target === "readOnlyFile") {
        parsed.readOnlyFiles.push(result.value);
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
  configuration: ConfigurationFile = {},
): BootstrapArguments {
  const encodingValue =
    commandLine.encoding ??
    environment.PATCH_ENCODING ??
    configuration.encoding ??
    "utf-8";
  const encoding = TextEncodingSchema.safeParse(encodingValue);
  if (!encoding.success) {
    throw new BootstrapArgumentError(
      `Unsupported text encoding: ${encodingValue}`,
    );
  }
  const editFormatValue =
    commandLine.editFormat ??
    environment.PATCH_EDIT_FORMAT ??
    configuration["edit-format"];
  const editFormat =
    editFormatValue === undefined
      ? undefined
      : ApplicationEditFormatSchema.safeParse(editFormatValue);
  if (editFormat !== undefined && !editFormat.success) {
    throw new BootstrapArgumentError(
      `Unsupported edit format: ${editFormatValue}`,
    );
  }

  return {
    configFile: commandLine.configFile ?? environment.PATCH_CONFIG,
    envFile:
      commandLine.envFile ??
      environment.PATCH_ENV_FILE ??
      configuration["env-file"],
    encoding: encoding.data,
    git:
      commandLine.git ??
      environmentBoolean(environment.PATCH_GIT, "PATCH_GIT") ??
      configuration.git ??
      true,
    model: commandLine.model ?? environment.PATCH_MODEL ?? configuration.model,
    lintCommand:
      commandLine.lintCommand ??
      environment.PATCH_LINT_CMD ??
      configuration["lint-cmd"],
    testCommand:
      commandLine.testCommand ??
      environment.PATCH_TEST_CMD ??
      configuration["test-cmd"],
    editFormat: editFormat?.data,
    files:
      commandLine.files.length > 0
        ? [...commandLine.files]
        : [...(configuration.files ?? [])],
    readOnlyFiles:
      commandLine.readOnlyFiles.length > 0
        ? [...commandLine.readOnlyFiles]
        : [...(configuration["read-only"] ?? [])],
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

async function loadConfigurationFiles(
  paths: readonly string[],
): Promise<ConfigurationFile> {
  const merged: ConfigurationFile = {};
  for (const path of paths) {
    try {
      const value = ConfigurationFileSchema.parse(
        parseYaml(await readFile(path, "utf8")),
      );
      Object.assign(merged, value);
    } catch (error) {
      throw new ConfigurationFileError(path, error);
    }
  }
  return merged;
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

export async function discoverCommonGitRoot(
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
  const rootForSearch = discoverFromCwd
    ? await discoverGitRoot(cwd)
    : suppliedRoot;

  const bootstrapArguments = resolveArguments(
    preliminaryCommandLine,
    baseEnvironment,
  );

  const configSearchPaths = await uniquePaths([
    join(home, CONFIG_FILE_NAME),
    rootForSearch === undefined
      ? undefined
      : join(rootForSearch, CONFIG_FILE_NAME),
    join(cwd, CONFIG_FILE_NAME),
    bootstrapArguments.configFile === undefined
      ? undefined
      : resolve(cwd, bootstrapArguments.configFile),
  ]);
  const configFiles = await existingFiles(configSearchPaths);
  const configuration = await loadConfigurationFiles(configFiles);
  const preliminaryArguments = resolveArguments(
    preliminaryCommandLine,
    baseEnvironment,
    configuration,
  );

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
    arguments: resolveArguments(finalCommandLine, environment, configuration),
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
  const selectedFiles = [
    ...first.arguments.files,
    ...first.arguments.readOnlyFiles,
  ];
  if (first.arguments.git && selectedFiles.length > 0) {
    selectedRoot = await discoverCommonGitRoot(selectedFiles, cwd);
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
