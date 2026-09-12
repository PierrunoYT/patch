import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AskEditStrategy,
  CoderSession,
  FakeProvider,
  ModelCatalog,
  ModelSettingsSchema,
  requestTemperature,
} from "../src/index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function catalogWith(
  settings: string,
  metadata: string,
): Promise<ModelCatalog> {
  const root = await mkdtemp(join(tmpdir(), "patch-metadata-"));
  directories.push(root);
  const settingsPath = join(root, "settings.yml");
  const metadataPath = join(root, "metadata.json5");
  await writeFile(settingsPath, settings);
  await writeFile(metadataPath, metadata);
  return ModelCatalog.load({
    settings: [settingsPath],
    metadata: [metadataPath],
  });
}

describe("catalog metadata merging", () => {
  it("folds limits, prices, and capabilities into the resolved settings", async () => {
    const catalog = await catalogWith(
      `- name: test/merged
  provider: openai
  editFormat: whole
  maxOutputTokens: 100
  capabilities:
    streaming: true
    images: false
`,
      `{
  "test/merged": {
    provider: "openai",
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    inputCostPerMillion: 0.28,
    outputCostPerMillion: 0.42,
    capabilities: { images: true },
  },
}`,
    );

    const resolved = catalog.resolve("test/merged");

    // Metadata describes the endpoint, so it wins for the fields it defines.
    expect(resolved.settings).toMatchObject({
      maxInputTokens: 128000,
      maxOutputTokens: 8192,
      inputCostPerMillion: 0.28,
      outputCostPerMillion: 0.42,
    });
    // Capabilities merge key by key rather than replacing the whole object.
    expect(resolved.settings.capabilities).toMatchObject({
      streaming: true,
      images: true,
    });
    expect(resolved.metadata).toMatchObject({ maxInputTokens: 128000 });
  });

  it("does not let omitted metadata capabilities erase settings", async () => {
    const catalog = await catalogWith(
      `- name: test/media
  provider: anthropic
  editFormat: ask
  capabilities:
    images: true
    documents: true
`,
      `{
  "test/media": {
    provider: "anthropic",
    capabilities: { promptCaching: true },
  },
}`,
    );

    expect(catalog.resolve("test/media").settings.capabilities).toMatchObject({
      images: true,
      documents: true,
      promptCaching: true,
    });
  });

  it("leaves a model with no metadata entry untouched", async () => {
    const catalog = await catalogWith(
      `- name: test/plain
  provider: openai
  editFormat: whole
  maxOutputTokens: 100
`,
      "{}",
    );

    const resolved = catalog.resolve("test/plain");

    expect(resolved.settings.maxOutputTokens).toBe(100);
    expect(resolved.settings.inputCostPerMillion).toBeUndefined();
    expect(resolved.metadata).toBeUndefined();
  });

  it("gives the bundled DeepSeek entry its catalog prices", async () => {
    const catalog = await ModelCatalog.load();

    // Without the merge these prices never reach a cost report.
    expect(catalog.resolve("deepseek").settings).toMatchObject({
      inputCostPerMillion: 0.28,
      outputCostPerMillion: 0.42,
      maxInputTokens: 128000,
    });
  });

  it("retains bundled image and document capabilities through metadata", async () => {
    const catalog = await ModelCatalog.load();

    expect(catalog.resolve("4o").settings.capabilities.images).toBe(true);
    expect(catalog.resolve("sonnet").settings.capabilities).toMatchObject({
      images: true,
      documents: true,
      promptCaching: true,
    });
  });

  it("gives every advertised bundled model its limits and prices", async () => {
    const catalog = await ModelCatalog.load();

    // A model with no input limit cannot be budgeted and reports an unknown
    // cost for every turn, so an entry added without metadata fails here
    // rather than degrading quietly in production.
    for (const name of catalog.list()) {
      expect({ ...catalog.resolve(name).settings, model: name }).toMatchObject({
        model: name,
        maxInputTokens: expect.any(Number),
        maxOutputTokens: expect.any(Number),
        inputCostPerMillion: expect.any(Number),
        outputCostPerMillion: expect.any(Number),
      });
    }
    expect(catalog.list()).toEqual([
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "deepseek/deepseek-chat",
      "deepseek/deepseek-reasoner",
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    expect(catalog.resolve("4o").settings).toMatchObject({
      maxInputTokens: 128000,
      inputCostPerMillion: 2.5,
      outputCostPerMillion: 10,
    });
    expect(catalog.resolve("sonnet").settings).toMatchObject({
      maxInputTokens: 1000000,
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      // A cache hit is a tenth of an ordinary input token and a cache write
      // costs a quarter more, so a cached turn must not be billed flat.
      cachedInputCostPerMillion: 0.3,
      cacheWriteCostPerMillion: 3.75,
    });
    // OpenAI rejects explicit cache control, so its bundled entries keep the
    // capability off even though the endpoint reports cached tokens.
    expect(catalog.resolve("4o").settings.capabilities.promptCaching).toBe(
      false,
    );
  });
});

describe("temperature policy", () => {
  const model = (useTemperature: unknown) =>
    ModelSettingsSchema.parse({
      name: "test/model",
      provider: "openai",
      editFormat: "whole",
      ...(useTemperature === undefined ? {} : { useTemperature }),
    });

  it("sends a deterministic zero by default and honours explicit choices", () => {
    expect(requestTemperature(model(undefined))).toBe(0);
    expect(requestTemperature(model(true))).toBe(0);
    expect(requestTemperature(model(0.6))).toBe(0.6);
    // Some reasoning models reject the parameter outright.
    expect(requestTemperature(model(false))).toBeUndefined();
  });

  it("omits the temperature for the bundled reasoner", async () => {
    const catalog = await ModelCatalog.load();

    expect(requestTemperature(catalog.resolve("r1").settings)).toBeUndefined();
    expect(requestTemperature(catalog.resolve("4o").settings)).toBe(0);
  });

  it("carries the policy into the request a turn sends", async () => {
    const root = await mkdtemp(join(tmpdir(), "patch-temperature-"));
    directories.push(root);
    const turn = () => ({
      actions: [
        { type: "text-delta", text: "answered" },
        { type: "finish", reason: "stop" },
      ],
    });
    const send = async (useTemperature: unknown) => {
      const provider = new FakeProvider([turn()]);
      const session = new CoderSession({
        config: {
          root,
          model: {
            name: "test/model",
            provider: "fake",
            editFormat: "ask",
            useTemperature,
          },
        },
        provider,
        strategy: new AskEditStrategy(),
      });
      await session.runTurn("question");
      return provider.requests[0]?.temperature;
    };

    expect(await send(true)).toBe(0);
    expect(await send(0.6)).toBe(0.6);
    expect(await send(false)).toBeUndefined();
  });
});
