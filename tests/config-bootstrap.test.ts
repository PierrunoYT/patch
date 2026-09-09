import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapConfiguration,
  BootstrapArgumentError,
  RepositorySelectionError,
} from "../src/index.js";

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-bootstrap-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function initializeRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await executeFile("git", ["init", "--quiet", path]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bootstrapConfiguration", () => {
  it("corrects a provisional root from selected files and reruns without leaked dotenv values", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    const firstRepository = join(parent, "first");
    const cwd = join(firstRepository, "nested");
    const selectedRepository = join(parent, "selected");
    const selectedFile = join(selectedRepository, "src", "selected.ts");
    await mkdir(home);
    await initializeRepository(firstRepository);
    await initializeRepository(selectedRepository);
    await mkdir(cwd);
    await mkdir(join(selectedRepository, "src"));
    await writeFile(selectedFile, "export {};\n");
    await writeFile(
      join(firstRepository, ".env"),
      "PATCH_MODEL=first-model\nFIRST_ONLY=present\n",
    );
    await writeFile(
      join(selectedRepository, ".env"),
      "PATCH_MODEL=selected-model\n",
    );
    await writeFile(join(selectedRepository, ".patch.conf.yml"), "model: x\n");

    const result = await bootstrapConfiguration({
      argv: ["--file", selectedFile],
      cwd,
      home,
      environment: {},
    });

    expect(result).toMatchObject({
      initialGitRoot: firstRepository,
      gitRoot: selectedRepository,
      rootCorrected: true,
      configFiles: [join(selectedRepository, ".patch.conf.yml")],
      dotenvFiles: [join(selectedRepository, ".env")],
      arguments: {
        model: "selected-model",
        files: [selectedFile],
      },
    });
    expect(result.environment.FIRST_ONLY).toBeUndefined();
    expect(result.configSearchPaths).toEqual([
      join(home, ".patch.conf.yml"),
      join(selectedRepository, ".patch.conf.yml"),
      join(cwd, ".patch.conf.yml"),
    ]);
  });

  it("loads dotenv files from low to high precedence and lets CLI flags win", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    const repository = join(parent, "repository");
    const cwd = join(repository, "nested");
    const explicitEnv = join(parent, "explicit.env");
    await mkdir(home);
    await initializeRepository(repository);
    await mkdir(cwd);
    await writeFile(join(home, ".env"), "SOURCE=home\nHOME_ONLY=yes\n");
    await writeFile(join(repository, ".env"), "SOURCE=repository\n");
    await writeFile(join(cwd, ".env"), "SOURCE=cwd\nPATCH_MODEL=dotenv\n");
    await writeFile(explicitEnv, "SOURCE=explicit\n");
    const sourceEnvironment = { PATCH_MODEL: "process" };

    const result = await bootstrapConfiguration({
      argv: ["--env-file", explicitEnv, "--model", "command-line"],
      cwd,
      home,
      environment: sourceEnvironment,
    });

    expect(result.dotenvFiles).toEqual([
      join(home, ".env"),
      join(repository, ".env"),
      join(cwd, ".env"),
      explicitEnv,
    ]);
    expect(result.environment).toMatchObject({
      SOURCE: "explicit",
      HOME_ONLY: "yes",
      PATCH_MODEL: "dotenv",
    });
    expect(result.arguments.model).toBe("command-line");
    expect(sourceEnvironment).toEqual({ PATCH_MODEL: "process" });
  });

  it("deduplicates search paths and supports Patch environment bootstrap controls", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    const repository = join(parent, "repository");
    const explicitConfig = join(parent, "custom.yml");
    const explicitEnv = join(parent, "custom.env");
    await mkdir(home);
    await initializeRepository(repository);
    await writeFile(join(repository, ".env"), "PATCH_MODEL=repository\n");
    await writeFile(explicitEnv, "PATCH_MODEL=explicit\n");
    await writeFile(explicitConfig, "model: configured\n");

    const result = await bootstrapConfiguration({
      cwd: repository,
      home,
      environment: {
        PATCH_CONFIG: explicitConfig,
        PATCH_ENV_FILE: explicitEnv,
        PATCH_ENCODING: "utf-8",
      },
    });

    expect(result.configSearchPaths).toEqual([
      join(home, ".patch.conf.yml"),
      join(repository, ".patch.conf.yml"),
      explicitConfig,
    ]);
    expect(result.dotenvSearchPaths).toEqual([
      join(home, ".env"),
      join(repository, ".env"),
      explicitEnv,
    ]);
    expect(result.configFiles).toEqual([explicitConfig]);
    expect(result.arguments).toMatchObject({
      configFile: explicitConfig,
      envFile: explicitEnv,
      encoding: "utf-8",
      model: "explicit",
    });
  });

  it("deduplicates explicit search paths through symlinks", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    const repository = join(parent, "repository");
    const envLink = join(parent, "linked.env");
    await mkdir(home);
    await initializeRepository(repository);
    await writeFile(join(repository, ".env"), "PATCH_MODEL=repository\n");
    await symlink(join(repository, ".env"), envLink);

    const result = await bootstrapConfiguration({
      argv: ["--env-file", envLink],
      cwd: repository,
      home,
      environment: {},
    });

    expect(result.dotenvSearchPaths).toEqual([
      join(home, ".env"),
      join(repository, ".env"),
    ]);
    expect(result.dotenvFiles).toEqual([join(repository, ".env")]);
  });

  it("honors --no-git without invoking repository correction", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    const cwd = join(parent, "working");
    await mkdir(home);
    await mkdir(cwd);
    await writeFile(join(home, ".env"), "SOURCE=home\n");
    await writeFile(join(cwd, ".env"), "SOURCE=cwd\n");

    const result = await bootstrapConfiguration({
      argv: ["--no-git", "/does/not/exist/file.ts"],
      cwd,
      home,
      environment: {},
    });

    expect(result).toMatchObject({
      initialGitRoot: undefined,
      gitRoot: undefined,
      rootCorrected: false,
      arguments: { git: false },
    });
    expect(result.environment.SOURCE).toBe("cwd");
  });

  it("still searches the provisional repository when Git operations are disabled", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    const repository = join(parent, "repository");
    await mkdir(home);
    await initializeRepository(repository);
    await writeFile(join(repository, ".env"), "SOURCE=repository\n");

    const result = await bootstrapConfiguration({
      argv: ["--no-git"],
      cwd: repository,
      home,
      environment: {},
    });

    expect(result).toMatchObject({
      initialGitRoot: repository,
      gitRoot: undefined,
      rootCorrected: false,
    });
    expect(result.environment.SOURCE).toBe("repository");
  });

  it("uses a nested repository for a missing selected file", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    const outer = join(parent, "outer");
    const nested = join(outer, "packages", "nested");
    const cwd = join(outer, "work");
    await mkdir(home);
    await initializeRepository(outer);
    await initializeRepository(nested);
    await mkdir(cwd);

    const result = await bootstrapConfiguration({
      argv: [join(nested, "new", "file.ts")],
      cwd,
      home,
      environment: {},
    });

    expect(result).toMatchObject({
      initialGitRoot: outer,
      gitRoot: nested,
      rootCorrected: true,
    });
  });

  it("rejects files spanning repositories and malformed bootstrap arguments", async () => {
    const parent = await temporaryDirectory();
    const home = join(parent, "home");
    const first = join(parent, "first");
    const second = join(parent, "second");
    await mkdir(home);
    await initializeRepository(first);
    await initializeRepository(second);
    await writeFile(join(first, "first.ts"), "");
    await writeFile(join(second, "second.ts"), "");

    await expect(
      bootstrapConfiguration({
        argv: [join(first, "first.ts"), join(second, "second.ts")],
        cwd: first,
        home,
        environment: {},
      }),
    ).rejects.toBeInstanceOf(RepositorySelectionError);
    await expect(
      bootstrapConfiguration({
        argv: ["--unknown"],
        cwd: first,
        home,
        environment: {},
      }),
    ).rejects.toThrow("Unknown option: --unknown");
    await expect(
      bootstrapConfiguration({
        argv: ["--model"],
        cwd: first,
        home,
        environment: {},
      }),
    ).rejects.toBeInstanceOf(BootstrapArgumentError);
    await expect(
      bootstrapConfiguration({
        cwd: first,
        home,
        environment: { PATCH_GIT: "sometimes" },
      }),
    ).rejects.toThrow("PATCH_GIT must be");
  });
});
