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
  ModelIdentifierSchema,
  ModelSettingsSchema,
  type ModelSettings,
} from "./settings.js";

/**
 * The capability fields, each optional and without a default. Metadata states
 * overrides, so a field the file does not mention must stay absent: parsing
 * this block with `ModelCapabilitiesSchema`'s defaults turned every unstated
 * capability into an explicit `false` that then overrode the settings being
 * merged into. The keys are derived rather than restated so the two lists
 * cannot drift apart.
 */
const MetadataCapabilitiesSchema = z
  .object(
    Object.fromEntries(
      Object.keys(ModelCapabilitiesSchema.shape).map((capability) => [
        capability,
        z.boolean().optional(),
      ]),
    ) as {
      [
        Capability in keyof typeof ModelCapabilitiesSchema.shape
      ]: z.ZodOptional<z.ZodBoolean>;
    },
  )
  .strict();

const ModelAliasesSchema = z
  .record(ModelIdentifierSchema, ModelIdentifierSchema)
  .refine((value) => Object.keys(value).length <= 512, {
    message: "A model alias file may define at most 512 aliases",
  });
const ModelSettingsFileSchema = z.array(ModelSettingsSchema).max(512);
export const ModelMetadataSchema = z
  .object({
    provider: ModelIdentifierSchema,
    maxInputTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    inputCostPerMillion: z.number().nonnegative().optional(),
    outputCostPerMillion: z.number().nonnegative().optional(),
    cachedInputCostPerMillion: z.number().nonnegative().optional(),
    cacheWriteCostPerMillion: z.number().nonnegative().optional(),
    capabilities: MetadataCapabilitiesSchema.optional(),
  })
  .strict();
const ModelMetadataFileSchema = z
  .record(ModelIdentifierSchema, ModelMetadataSchema)
  .refine((value) => Object.keys(value).length <= 512, {
    message: "A model metadata file may define at most 512 models",
  });

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

export interface ModelCatalogMatch {
  readonly name: string;
  readonly provider: string;
  readonly editFormat: ModelSettings["editFormat"];
}

export interface ModelCatalogSearch {
  readonly matches: readonly ModelCatalogMatch[];
  readonly total: number;
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

/**
 * Folds a catalog metadata entry into the settings a session actually uses.
 *
 * Settings describe behavior; metadata describes the endpoint's limits, prices,
 * and capabilities, which is where cost reporting and the token budget come
 * from. Metadata wins for the fields it defines, as upstream's
 * `model-metadata.json` overrides LiteLLM's model info, and capabilities merge
 * key by key so a metadata entry need only state what it changes.
 */
function mergeMetadata(
  settings: ModelSettings,
  metadata: ModelMetadata | undefined,
): ModelSettings {
  if (metadata === undefined) return settings;
  return ModelSettingsSchema.parse({
    ...settings,
    ...(metadata.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: metadata.maxInputTokens }),
    ...(metadata.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: metadata.maxOutputTokens }),
    ...(metadata.inputCostPerMillion === undefined
      ? {}
      : { inputCostPerMillion: metadata.inputCostPerMillion }),
    ...(metadata.outputCostPerMillion === undefined
      ? {}
      : { outputCostPerMillion: metadata.outputCostPerMillion }),
    ...(metadata.cachedInputCostPerMillion === undefined
      ? {}
      : { cachedInputCostPerMillion: metadata.cachedInputCostPerMillion }),
    ...(metadata.cacheWriteCostPerMillion === undefined
      ? {}
      : { cacheWriteCostPerMillion: metadata.cacheWriteCostPerMillion }),
    capabilities: { ...settings.capabilities, ...metadata.capabilities },
  });
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
    for (const [kind, sources] of Object.entries(files)) {
      if ((sources?.length ?? 0) > 8) {
        throw new ModelResourceError(
          `${kind} files`,
          new Error("A catalog kind may load at most 8 override files"),
        );
      }
    }
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

    const catalog = new ModelCatalog(aliases, settings, metadata);
    for (const alias of aliases.keys()) {
      try {
        catalog.resolve(alias);
      } catch (error) {
        throw new ModelResourceError("model aliases", error);
      }
    }
    return catalog;
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
    const metadata = structuredClone(this.#metadata.get(canonicalName));
    return {
      requestedName: name,
      canonicalName,
      settings: mergeMetadata(structuredClone(settings), metadata),
      metadata,
    };
  }

  list(): string[] {
    return [...this.#settings.keys()].sort();
  }

  search(query = "", limit = 50): ModelCatalogSearch {
    const parsedQuery = z
      .string()
      .trim()
      .max(256)
      .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]*$/u)
      .safeParse(query);
    if (
      !parsedQuery.success ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new ModelResourceError(
        "model search",
        new Error(
          "Search must be at most 256 safe characters with a bounded limit",
        ),
      );
    }
    const normalized = parsedQuery.data.toLocaleLowerCase();
    const names = new Set(
      [...this.#settings.keys()].filter((name) =>
        name.toLocaleLowerCase().includes(normalized),
      ),
    );
    for (const [alias, target] of this.#aliases) {
      if (
        alias.toLocaleLowerCase().includes(normalized) ||
        target.toLocaleLowerCase().includes(normalized)
      ) {
        names.add(this.resolve(alias).canonicalName);
      }
    }
    const ordered = [...names].sort((left, right) => left.localeCompare(right));
    return {
      matches: ordered.slice(0, limit).map((name) => {
        const settings = this.resolve(name).settings;
        return {
          name,
          provider: settings.provider,
          editFormat: settings.editFormat,
        };
      }),
      total: ordered.length,
    };
  }
}

export function renderModelMatches(catalog: ModelCatalog, query = ""): string {
  const { matches, total } = catalog.search(query);
  if (matches.length === 0) {
    return query.trim() === ""
      ? "No models are configured"
      : `No models match ${JSON.stringify(query.trim())}`;
  }
  const heading =
    query.trim() === ""
      ? "Known models:"
      : `Models matching ${JSON.stringify(query.trim())}:`;
  const lines = matches.map(
    ({ name, provider, editFormat }) => `${name} (${provider}, ${editFormat})`,
  );
  if (total > matches.length) {
    lines.push(`… ${total - matches.length} more models omitted`);
  }
  return [heading, ...lines].join("\n");
}
