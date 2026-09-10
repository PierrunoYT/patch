/**
 * Resource loading adapted from aider/models.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch with immutable, validated model records and packaged resources.
 * Licensed under the Apache License, Version 2.0.
 */

import { readFile } from "node:fs/promises";

import JSON5 from "json5";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  ModelCapabilitiesSchema,
  ModelSettingsSchema,
  type ModelSettings,
} from "./settings.js";

const ModelAliasesSchema = z.record(z.string().min(1), z.string().min(1));
const ModelSettingsFileSchema = z.array(ModelSettingsSchema);
export const ModelMetadataSchema = z
  .object({
    provider: z.string().min(1),
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    inputCostPerMillion: z.number().nonnegative().optional(),
    outputCostPerMillion: z.number().nonnegative().optional(),
    capabilities: ModelCapabilitiesSchema.partial().optional(),
  })
  .strict();
const ModelMetadataFileSchema = z.record(
  z.string().min(1),
  ModelMetadataSchema,
);

export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

export interface ModelCatalogFiles {
  readonly aliases?: readonly (string | URL)[];
  readonly settings?: readonly (string | URL)[];
  readonly metadata?: readonly (string | URL)[];
}

export interface ResolvedModel {
  readonly requestedName: string;
  readonly canonicalName: string;
  readonly settings: ModelSettings;
  readonly metadata: ModelMetadata | undefined;
}

export class ModelResourceError extends Error {
  override readonly name = "ModelResourceError";
  readonly source: string;

  constructor(source: string | URL, cause: unknown) {
    super(`Invalid model resource: ${source.toString()}`, { cause });
    this.source = source.toString();
  }
}

export class UnknownModelError extends Error {
  override readonly name = "UnknownModelError";

  constructor(name: string) {
    super(`Unknown model: ${name}`);
  }
}

const bundledFiles: Required<ModelCatalogFiles> = {
  aliases: [new URL("../resources/model-aliases.json5", import.meta.url)],
  settings: [new URL("../resources/model-settings.yml", import.meta.url)],
  metadata: [new URL("../resources/model-metadata.json5", import.meta.url)],
};

async function loadFiles<T>(
  sources: readonly (string | URL)[],
  parse: (content: string) => T,
): Promise<T[]> {
  const values: T[] = [];
  for (const source of sources) {
    try {
      values.push(parse(await readFile(source, "utf8")));
    } catch (error) {
      throw new ModelResourceError(source, error);
    }
  }
  return values;
}

export class ModelCatalog {
  readonly #aliases: ReadonlyMap<string, string>;
  readonly #settings: ReadonlyMap<string, ModelSettings>;
  readonly #metadata: ReadonlyMap<string, ModelMetadata>;

  private constructor(
    aliases: ReadonlyMap<string, string>,
    settings: ReadonlyMap<string, ModelSettings>,
    metadata: ReadonlyMap<string, ModelMetadata>,
  ) {
    this.#aliases = aliases;
    this.#settings = settings;
    this.#metadata = metadata;
  }

  static async load(files: ModelCatalogFiles = {}): Promise<ModelCatalog> {
    const aliasDocuments = await loadFiles(
      [...bundledFiles.aliases, ...(files.aliases ?? [])],
      (content) => ModelAliasesSchema.parse(JSON5.parse(content)),
    );
    const settingDocuments = await loadFiles(
      [...bundledFiles.settings, ...(files.settings ?? [])],
      (content) => ModelSettingsFileSchema.parse(parseYaml(content)),
    );
    const metadataDocuments = await loadFiles(
      [...bundledFiles.metadata, ...(files.metadata ?? [])],
      (content) => ModelMetadataFileSchema.parse(JSON5.parse(content)),
    );

    const aliases = new Map<string, string>();
    for (const document of aliasDocuments) {
      for (const [alias, name] of Object.entries(document)) {
        aliases.set(alias, name);
      }
    }
    const settings = new Map<string, ModelSettings>();
    for (const document of settingDocuments) {
      for (const model of document) {
        settings.set(model.name, Object.freeze(structuredClone(model)));
      }
    }
    const metadata = new Map<string, ModelMetadata>();
    for (const document of metadataDocuments) {
      for (const [name, value] of Object.entries(document)) {
        metadata.set(name, Object.freeze(structuredClone(value)));
      }
    }

    return new ModelCatalog(aliases, settings, metadata);
  }

  resolve(name: string): ResolvedModel {
    const visited = new Set<string>();
    let canonicalName = name;
    while (this.#aliases.has(canonicalName)) {
      if (visited.has(canonicalName)) {
        throw new ModelResourceError(
          "model aliases",
          new Error(`Alias cycle includes ${canonicalName}`),
        );
      }
      visited.add(canonicalName);
      canonicalName = this.#aliases.get(canonicalName) ?? canonicalName;
    }

    const settings = this.#settings.get(canonicalName);
    if (settings === undefined) {
      throw new UnknownModelError(canonicalName);
    }
    return {
      requestedName: name,
      canonicalName,
      settings: structuredClone(settings),
      metadata: structuredClone(this.#metadata.get(canonicalName)),
    };
  }

  list(): string[] {
    return [...this.#settings.keys()].sort();
  }
}
