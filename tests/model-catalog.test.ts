import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ModelCatalog,
  ModelResourceError,
  renderModelMatches,
  UnknownModelError,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "patch-models-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ModelCatalog", () => {
  it("loads bundled aliases, settings, and commented JSON5 metadata", async () => {
    const catalog = await ModelCatalog.load();

    expect(catalog.list()).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    // Reasoning arrives inside the content stream for this one.
    expect(catalog.resolve("r1")).toMatchObject({
      canonicalName: "deepseek/deepseek-reasoner",
      settings: { reasoningTag: "think" },
    });
    expect(catalog.resolve("4o")).toMatchObject({
      requestedName: "4o",
      canonicalName: "gpt-4o",
      settings: {
        provider: "openai",
        editFormat: "diff",
        editorEditFormat: "diff",
      },
    });
    expect(catalog.resolve("gpt-4o-mini")).toMatchObject({
      settings: {
        editFormat: "whole",
        useRepoMap: false,
      },
    });
    expect(catalog.resolve("deepseek")).toMatchObject({
      canonicalName: "deepseek/deepseek-chat",
      metadata: {
        maxInputTokens: 128_000,
        inputCostPerMillion: 0.28,
        capabilities: { promptCaching: true },
      },
    });
  });

  it("applies validated user resource overrides after bundled resources", async () => {
    const directory = await temporaryDirectory();
    const aliases = join(directory, "aliases.json5");
    const settings = join(directory, "settings.yml");
    const metadata = join(directory, "metadata.json5");
    await writeFile(aliases, "{ fast: 'custom/model' }");
    await writeFile(
      settings,
      "- name: custom/model\n  provider: custom\n  editFormat: whole\n",
    );
    await writeFile(
      metadata,
      "{ 'custom/model': { provider: 'custom', maxInputTokens: 4096 } }",
    );

    const catalog = await ModelCatalog.load({
      aliases: [aliases],
      settings: [settings],
      metadata: [metadata],
    });

    expect(catalog.resolve("fast")).toMatchObject({
      canonicalName: "custom/model",
      settings: { provider: "custom", editFormat: "whole" },
      metadata: { maxInputTokens: 4096 },
    });
  });

  it("returns defensive copies and rejects unknown models", async () => {
    const catalog = await ModelCatalog.load();
    const first = catalog.resolve("4o");
    first.settings.extraParameters.changed = true;

    expect(catalog.resolve("4o").settings.extraParameters).toEqual({});
    expect(() => catalog.resolve("missing/model")).toThrow(UnknownModelError);
  });

  it("rejects malformed resources and alias cycles", async () => {
    const directory = await temporaryDirectory();
    const malformed = join(directory, "malformed.yml");
    const aliases = join(directory, "aliases.json5");
    await writeFile(malformed, "- name: invalid\n  unsupported: true\n");
    await writeFile(aliases, "{ first: 'second', second: 'first' }");

    await expect(
      ModelCatalog.load({ settings: [malformed] }),
    ).rejects.toBeInstanceOf(ModelResourceError);

    await expect(
      ModelCatalog.load({ aliases: [aliases] }),
    ).rejects.toBeInstanceOf(ModelResourceError);
    await writeFile(aliases, "{ missing: 'not-configured' }");
    await expect(
      ModelCatalog.load({ aliases: [aliases] }),
    ).rejects.toBeInstanceOf(ModelResourceError);
  });

  it("searches bounded public model fields without exposing metadata", async () => {
    const catalog = await ModelCatalog.load();

    expect(catalog.search("deepseek")).toMatchObject({
      total: 2,
      matches: [
        { name: "deepseek/deepseek-chat", provider: "deepseek" },
        { name: "deepseek/deepseek-reasoner", provider: "deepseek" },
      ],
    });
    const rendered = renderModelMatches(catalog, "4o");
    expect(rendered).toContain("gpt-4o (openai, diff)");
    expect(rendered).not.toContain("inputCostPerMillion");
    expect(() => catalog.search("unsafe\u001bquery")).toThrow(
      ModelResourceError,
    );
    expect(() => catalog.search("", 101)).toThrow(ModelResourceError);
  });

  it("bounds override files and resource identifiers", async () => {
    const directory = await temporaryDirectory();
    const invalid = join(directory, "invalid.yml");
    await writeFile(
      invalid,
      '- name: "unsafe\\u0000model"\n  provider: openai\n  editFormat: whole\n',
    );
    await expect(
      ModelCatalog.load({ settings: Array(9).fill(invalid) }),
    ).rejects.toBeInstanceOf(ModelResourceError);
    await expect(
      ModelCatalog.load({ settings: [invalid] }),
    ).rejects.toBeInstanceOf(ModelResourceError);
  });
});
