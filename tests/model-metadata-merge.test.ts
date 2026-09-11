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
