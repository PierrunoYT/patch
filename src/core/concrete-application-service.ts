import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  bootstrapConfiguration,
  type BootstrapOptions,
  type ConfigurationBootstrap,
} from "../config/bootstrap.js";
import { RepositoryMap } from "../context/repository-map.js";
import { createStrategy, type StrategyDefinition } from "../edits/registry.js";
import type { FileSnapshot } from "../edits/resolve.js";
import { selectFence } from "./fences.js";
import { FileSystemAdapter } from "../io/filesystem.js";
import { SafePathResolver } from "../io/safe-path.js";
import { ModelCatalog } from "../models/catalog.js";
import { selectModels, type ModelSelection } from "../models/selection.js";
import type { ModelProvider } from "../providers/events.js";
import { createProvider } from "../providers/factory.js";
import { GitRepository } from "../repository/git.js";
import { COMMON_PROMPTS } from "../resources/prompts.js";
import type {
  ApplicationService,
  ApplicationSession,
  ApplicationSubmitOptions,
} from "./application-service.js";
import { CoderSession } from "./coder-session.js";
import type { ChatMessage } from "./messages.js";
import { SerialTaskQueue } from "./serial-queue.js";

export interface ConcreteApplicationDependencies {
  readonly catalog?: ModelCatalog;
  readonly provider?: ModelProvider;
  readonly createProvider?: typeof createProvider;
  readonly approvePath?: (path: string) => boolean | Promise<boolean>;
}

export interface ConcreteApplicationOptions extends BootstrapOptions {
  readonly dependencies?: ConcreteApplicationDependencies;
}

interface ApplicationContext {
  readonly bootstrap: ConfigurationBootstrap;
  readonly root: string;
  readonly files: FileSystemAdapter;
  readonly repository?: GitRepository;
  readonly models: ModelSelection;
  readonly provider: ModelProvider;
  readonly definition: StrategyDefinition;
  readonly editablePaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
  readonly availablePaths: readonly string[];
  readonly repositoryMap?: RepositoryMap;
  readonly fence: readonly [string, string];
  readonly approvePath?: (path: string) => boolean | Promise<boolean>;
}

function portablePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

async function selectedPaths(
  resolver: SafePathResolver,
  paths: readonly string[],
): Promise<string[]> {
  const selected: string[] = [];
  for (const path of paths) {
    const normalized = portablePath(
      resolver.root,
      await resolver.resolve(path),
    );
    if (normalized === "") throw new Error("The repository root is not a file");
    if (!selected.includes(normalized)) selected.push(normalized);
  }
  return selected;
}

async function snapshot(
  files: FileSystemAdapter,
  path: string,
): Promise<FileSnapshot> {
  try {
    return { path, content: (await files.readText(path)).content };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { path, content: null };
    }
    throw error;
  }
}

function fileMessage(
  prefix: string,
  values: readonly FileSnapshot[],
): ChatMessage[] {
  const existing = values.filter(
    (value): value is { path: string; content: string } =>
      value.content !== null,
  );
  if (existing.length === 0) return [];
  return [
    {
      role: "user",
      content: `${prefix}\n\n${existing
        .map(({ path, content }) => `${path}\n\`\`\`\n${content}\`\`\``)
        .join("\n\n")}`,
    },
  ];
}

function identifierHints(message: string): string[] {
  return [...new Set(message.match(/[\p{L}_][\p{L}\p{N}_]{2,}/gu) ?? [])];
}

class ConcreteApplicationSession implements ApplicationSession {
  readonly queue = new SerialTaskQueue();
  readonly #lifecycle = new AbortController();
  readonly #context: ApplicationContext;
  readonly #session: CoderSession;
  #closed = false;

  constructor(context: ApplicationContext) {
    this.#context = context;
    const model = {
      ...context.models.main.settings,
      editFormat: context.definition.strategy.format,
    };
    this.#session = new CoderSession({
      config: {
        root: context.root,
        model,
        autoCommit: context.bootstrap.arguments.git,
        autoLint: context.bootstrap.arguments.lintCommand !== undefined,
        autoTest: context.bootstrap.arguments.testCommand !== undefined,
      },
      provider: context.provider,
      strategy: context.definition.strategy,
      editablePaths: context.editablePaths,
      readOnlyPaths: context.readOnlyPaths,
      availablePaths: context.availablePaths,
      fence: context.fence,
      ...(context.approvePath === undefined
        ? {}
        : { approvePath: ({ path }) => context.approvePath?.(path) ?? false }),
    });
  }

  snapshot() {
    return this.#session.snapshot();
  }

  submit(message: string, options: ApplicationSubmitOptions): Promise<string> {
    return this.queue.run(async () => {
      if (this.#closed) throw new Error("Application session is closed");
      const editable = await Promise.all(
        this.#session
          .snapshot()
          .editablePaths.map((path) => snapshot(this.#context.files, path)),
      );
      const readOnly = await Promise.all(
        this.#session
          .snapshot()
          .readOnlyPaths.map((path) => snapshot(this.#context.files, path)),
      );
      const snapshots = [...editable, ...readOnly];
      const repositoryContent = await this.#repositoryContext(message);
      const prompt = {
        system: [
          {
            role: "system" as const,
            content: this.#context.definition.systemPrompt,
          },
        ],
        examples: [
          ...COMMON_PROMPTS.exampleMessages,
          ...this.#context.definition.examples,
        ],
        readOnlyFiles: fileMessage(
          COMMON_PROMPTS.readOnlyFilesPrefix,
          readOnly,
        ),
        repository:
          repositoryContent === ""
            ? []
            : [
                {
                  role: "user" as const,
                  content: `${COMMON_PROMPTS.repoContentPrefix}\n\n${repositoryContent}`,
                },
              ],
        editableFiles: fileMessage(COMMON_PROMPTS.filesContentPrefix, editable),
        reminder: [
          {
            role: "system" as const,
            content: `${this.#context.definition.reminder}\n${
              this.#context.definition.allowShellCommands
                ? "Shell commands may be suggested only in fenced shell blocks; execution always requires approval."
                : "Do not suggest shell commands."
            }`,
          },
        ],
      };
      const completed = await this.#session.runTurn(message, {
        prompt,
        snapshots,
        signal: AbortSignal.any([options.signal, this.#lifecycle.signal]),
        onEvent: (event) => options.emit({ type: event.type, data: event }),
      });
      return completed.response;
    }, options.signal);
  }

  close(): void {
    this.#closed = true;
    this.#lifecycle.abort(new Error("Application session closed"));
  }

  async #repositoryContext(message: string): Promise<string> {
    const map = this.#context.repositoryMap;
    if (map === undefined) return "";
    const selected = new Set([
      ...this.#session.snapshot().editablePaths,
      ...this.#session.snapshot().readOnlyPaths,
    ]);
    const mentionedPaths = this.#context.availablePaths.filter((path) =>
      message.includes(path),
    );
    return map.getMap({
      chatPaths: [...selected],
      otherPaths: this.#context.availablePaths.filter(
        (path) => !selected.has(path),
      ),
      mentionedPaths,
      mentionedIdentifiers: identifierHints(message),
    });
  }
}

export class ConcreteApplicationService implements ApplicationService {
  readonly #context: ApplicationContext;
  readonly #sessions = new Set<ConcreteApplicationSession>();

  private constructor(context: ApplicationContext) {
    this.#context = context;
  }

  static async create(
    options: ConcreteApplicationOptions = {},
  ): Promise<ConcreteApplicationService> {
    const bootstrap = await bootstrapConfiguration(options);
    if (bootstrap.arguments.model === undefined) {
      throw new Error(
        "No model is configured. Pass --model, set PATCH_MODEL, or add model to .patch.conf.yml.",
      );
    }
    const root = await realpath(
      bootstrap.gitRoot ?? resolve(options.cwd ?? process.cwd()),
    );
    const resolver = await SafePathResolver.create(root);
    const editablePaths = await selectedPaths(
      resolver,
      bootstrap.arguments.files,
    );
    const readOnlyPaths = await selectedPaths(
      resolver,
      bootstrap.arguments.readOnlyFiles,
    );
    const overlap = readOnlyPaths.find((path) => editablePaths.includes(path));
    if (overlap !== undefined) {
      throw new Error(
        `A path cannot be both editable and read-only: ${overlap}`,
      );
    }
    const catalog =
      options.dependencies?.catalog ?? (await ModelCatalog.load());
    const models = selectModels(catalog, { main: bootstrap.arguments.model });
    const requestedFormat =
      bootstrap.arguments.editFormat ?? models.main.settings.editFormat;
    const definition = createStrategy(requestedFormat);
    const provider =
      options.dependencies?.provider ??
      (options.dependencies?.createProvider ?? createProvider)(
        { ...models.main.settings, editFormat: requestedFormat },
        { environment: bootstrap.environment },
      );
    const files = await FileSystemAdapter.create(root, {
      encoding: bootstrap.arguments.encoding,
    });
    const initialSnapshots = await Promise.all(
      [...editablePaths, ...readOnlyPaths].map((path) => snapshot(files, path)),
    );
    const fence = selectFence(
      initialSnapshots.flatMap(({ content }) =>
        content === null ? [] : [content],
      ),
    ).fence;
    const repository = bootstrap.arguments.git
      ? await GitRepository.open(root)
      : undefined;
    const availablePaths =
      repository === undefined
        ? [...new Set([...editablePaths, ...readOnlyPaths])]
        : (await repository.status()).trackedPaths;
    const repositoryMap =
      models.main.settings.useRepoMap && repository !== undefined
        ? await RepositoryMap.create({
            root,
            maxTokens: 1024,
            countTokens: (text) => Math.ceil(text.length / 4),
          })
        : undefined;
    return new ConcreteApplicationService({
      bootstrap,
      root,
      files,
      ...(repository === undefined ? {} : { repository }),
      models,
      provider,
      definition,
      editablePaths,
      readOnlyPaths,
      availablePaths,
      fence,
      ...(repositoryMap === undefined ? {} : { repositoryMap }),
      ...(options.dependencies?.approvePath === undefined
        ? {}
        : { approvePath: options.dependencies.approvePath }),
    });
  }

  createSession(_context: {
    readonly principal: string;
    readonly sessionId: string;
  }): ApplicationSession {
    void _context;
    const session = new ConcreteApplicationSession(this.#context);
    this.#sessions.add(session);
    return session;
  }

  async close(): Promise<void> {
    for (const session of this.#sessions) session.close();
    this.#sessions.clear();
    await this.#context.provider.close?.();
  }
}
