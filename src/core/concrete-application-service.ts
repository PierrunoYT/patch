import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  bootstrapConfiguration,
  type BootstrapOptions,
  type ConfigurationBootstrap,
} from "../config/bootstrap.js";
import type { CommandEffect } from "../commands/effects.js";
import { parseCommand } from "../commands/parse.js";
import { RepositoryMap } from "../context/repository-map.js";
import { createStrategy, type StrategyDefinition } from "../edits/registry.js";
import { resolveEditBatch, type FileSnapshot } from "../edits/resolve.js";
import { EditTransaction } from "../edits/transaction.js";
import {
  applyAuthorizedEdits,
  type WriteAuthorizationRequest,
} from "../edits/write-boundary.js";
import { selectFence } from "./fences.js";
import { FileSystemAdapter } from "../io/filesystem.js";
import { readClipboardText, writeClipboardText } from "../io/integrations.js";
import { SafePathResolver } from "../io/safe-path.js";
import { ModelCatalog } from "../models/catalog.js";
import type { ModelSettings } from "../models/settings.js";
import { selectModels, type ModelSelection } from "../models/selection.js";
import type { ModelProvider } from "../providers/events.js";
import { createProvider } from "../providers/factory.js";
import {
  executeModelCommand,
  executeModelCommands,
  type ModelCommandResult,
} from "../process/model-command.js";
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
  readonly authorizeWrite?: (
    request: WriteAuthorizationRequest,
  ) => boolean | Promise<boolean>;
  readonly approveCommand?: (command: string) => boolean | Promise<boolean>;
  readonly readClipboard?: () => Promise<string>;
  readonly writeClipboard?: (text: string) => Promise<void>;
}

export interface ConcreteApplicationOptions extends BootstrapOptions {
  readonly dependencies?: ConcreteApplicationDependencies;
}

interface ApplicationContext {
  readonly bootstrap: ConfigurationBootstrap;
  readonly catalog: ModelCatalog;
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
  readonly authorizeWrite?: (
    request: WriteAuthorizationRequest,
  ) => boolean | Promise<boolean>;
  readonly approveCommand?: (command: string) => boolean | Promise<boolean>;
  readonly makeProvider: (model: ModelSettings) => ModelProvider;
  readonly readClipboard: () => Promise<string>;
  readonly writeClipboard: (text: string) => Promise<void>;
}

export interface ApplicationTurnResult {
  readonly response: string;
  readonly changedPaths: readonly string[];
  readonly commit: string | null;
  readonly commands: readonly ModelCommandResult[];
  readonly exit?: boolean;
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
      approvePath: async ({ path }) => {
        const resolver = await SafePathResolver.create(context.root);
        await resolver.resolve(path);
        return context.approvePath?.(path) ?? true;
      },
    });
  }

  snapshot() {
    return this.#session.snapshot();
  }

  submit(
    message: string,
    options: ApplicationSubmitOptions,
  ): Promise<ApplicationTurnResult> {
    options = {
      ...options,
      signal: AbortSignal.any([options.signal, this.#lifecycle.signal]),
    };
    return this.queue.run(async () => {
      if (this.#closed) throw new Error("Application session is closed");
      const effect = parseCommand(message);
      if (options.readOnly === true && effect.type !== "submit")
        throw new Error("Question-only input cannot run slash commands");
      if (effect.type !== "submit") return this.#dispatch(effect, options);
      message = effect.message;
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
      const selectedPaths = new Set(
        [...editable, ...readOnly].map(({ path }) => path),
      );
      const unselected = await Promise.all(
        this.#context.availablePaths
          .filter((path) => !selectedPaths.has(path))
          .map((path) => snapshot(this.#context.files, path)),
      );
      const snapshots = [...editable, ...readOnly, ...unselected];
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
      if (options.readOnly === true) {
        this.#session.recordApplied();
        return {
          response: completed.response,
          changedPaths: [],
          commit: null,
          commands: [],
        };
      }
      const editPaths = completed.edits.edits.flatMap((edit) =>
        edit.kind === "move" ? [edit.fromPath, edit.path] : [edit.path],
      );
      const expandedSnapshots = [...snapshots];
      for (const path of editPaths) {
        if (!expandedSnapshots.some((file) => file.path === path)) {
          expandedSnapshots.push(await snapshot(this.#context.files, path));
        }
      }
      const resolved = resolveEditBatch(completed.edits, expandedSnapshots);
      if (
        resolved.operations.length === 0 &&
        resolved.shellCommands.length === 0
      ) {
        this.#session.recordApplied();
        return {
          response: completed.response,
          changedPaths: [],
          commit: null,
          commands: [],
        };
      }

      const transaction = await EditTransaction.stage(
        this.#context.files,
        resolved,
      );
      const repository = this.#context.repository;
      const write = await applyAuthorizedEdits(
        transaction,
        this.#context.editablePaths,
        {
          presentPreview: (preview) =>
            options.emit({ type: "edit-preview", data: preview }),
          authorize: (request) =>
            this.#context.authorizeWrite?.(request) ?? false,
          isDirty: (path) => repository?.isDirty(path) ?? false,
          checkpointDirty: async (paths) =>
            (
              await repository?.commit({
                paths: [...paths],
                message: "Checkpoint before Patch edits",
                verify: false,
              })
            )?.commit,
        },
      );
      const commit = await this.#commit(
        write.changedPaths,
        "Apply Patch edits",
      );
      const signal = AbortSignal.any([options.signal, this.#lifecycle.signal]);
      await this.#runCheck(
        "lint",
        this.#context.bootstrap.arguments.lintCommand,
        signal,
        write.changedPaths,
        options,
      );
      const commands = await executeModelCommands(
        resolved.shellCommands,
        { root: this.#context.root, signal },
        {
          show: (command) =>
            options.emit({ type: "command-preview", data: { command } }),
          approve: (command) =>
            this.#context.approveCommand?.(command) ?? false,
        },
      );
      await this.#runCheck(
        "test",
        this.#context.bootstrap.arguments.testCommand,
        signal,
        write.changedPaths,
        options,
      );
      this.#session.recordApplied(commit);
      return {
        response: completed.response,
        changedPaths: write.changedPaths,
        commit,
        commands,
      };
    }, options.signal);
  }

  close(): void {
    this.#closed = true;
    this.#lifecycle.abort(new Error("Application session closed"));
  }

  async #dispatch(
    effect: Exclude<CommandEffect, { type: "submit" }>,
    options: ApplicationSubmitOptions,
  ): Promise<ApplicationTurnResult> {
    const state = this.#session.snapshot();
    const resolver = await SafePathResolver.create(this.#context.root);
    const normalize = async (paths: readonly string[]) =>
      Promise.all(
        paths.map(async (path) =>
          portablePath(this.#context.root, await resolver.resolve(path)),
        ),
      );
    const result = (
      response: string,
      extra: Partial<ApplicationTurnResult> = {},
    ): ApplicationTurnResult => {
      if (response !== "") {
        options.emit({
          type: "text-delta",
          data: { type: "text-delta", text: `${response}\n` },
        });
      }
      return {
        response,
        changedPaths: [],
        commit: null,
        commands: [],
        ...extra,
      };
    };

    switch (effect.type) {
      case "none":
        return result("");
      case "add": {
        const paths = await normalize(effect.paths);
        for (const path of paths) {
          if (
            !(await this.#context.approvePath?.(path)) &&
            this.#context.approvePath !== undefined
          ) {
            throw new Error(`Adding path was not approved: ${path}`);
          }
        }
        this.#session.setSelectedPaths(
          [...new Set([...state.editablePaths, ...paths])],
          state.readOnlyPaths.filter((path) => !paths.includes(path)),
        );
        return result(`Added: ${paths.join(", ")}`);
      }
      case "read-only": {
        const paths = await normalize(effect.paths);
        this.#session.setSelectedPaths(
          state.editablePaths.filter((path) => !paths.includes(path)),
          [...new Set([...state.readOnlyPaths, ...paths])],
        );
        return result(`Read-only: ${paths.join(", ")}`);
      }
      case "drop": {
        const paths = await normalize(effect.paths);
        this.#session.setSelectedPaths(
          effect.paths.length === 0
            ? []
            : state.editablePaths.filter((path) => !paths.includes(path)),
          effect.paths.length === 0
            ? []
            : state.readOnlyPaths.filter((path) => !paths.includes(path)),
        );
        return result(
          effect.paths.length === 0
            ? "Dropped all files"
            : `Dropped: ${paths.join(", ")}`,
        );
      }
      case "ls":
        return result(
          [
            `Editable: ${state.editablePaths.join(", ") || "(none)"}`,
            `Read-only: ${state.readOnlyPaths.join(", ") || "(none)"}`,
          ].join("\n"),
        );
      case "clear":
        this.#session.clearHistory();
        return result("Chat history cleared");
      case "model": {
        const resolved = this.#context.catalog.resolve(effect.model);
        const definition = createStrategy(resolved.settings.editFormat);
        await this.#session.switch({
          model: resolved.settings,
          provider: this.#context.makeProvider(resolved.settings),
          strategy: definition.strategy,
        });
        return result(`Model: ${resolved.canonicalName}`);
      }
      case "chat-mode": {
        const format =
          effect.mode === "code"
            ? this.#context.models.main.settings.editFormat
            : effect.mode;
        const definition = createStrategy(format);
        const model = { ...state.config.model, editFormat: format };
        await this.#session.switch({
          model,
          provider: this.#context.makeProvider(model),
          strategy: definition.strategy,
        });
        return result(`Chat mode: ${format}`);
      }
      case "run": {
        const command = await executeModelCommand(
          effect.command,
          { root: this.#context.root, signal: options.signal },
          {
            show: (command) =>
              options.emit({ type: "command-preview", data: { command } }),
            approve: (command) =>
              this.#context.approveCommand?.(command) ?? false,
          },
        );
        return result(command.stdout || command.stderr, {
          commands: [command],
        });
      }
      case "lint":
      case "test": {
        const command =
          effect.type === "lint"
            ? this.#context.bootstrap.arguments.lintCommand
            : this.#context.bootstrap.arguments.testCommand;
        if (command === undefined)
          throw new Error(`No ${effect.type} command is configured`);
        await this.#runCheck(
          effect.type,
          command,
          options.signal,
          state.editablePaths,
          options,
        );
        return result(`${effect.type} passed`);
      }
      case "commit": {
        const commit = await this.#commit(
          state.editablePaths,
          effect.message ?? "Commit selected Patch files",
        );
        return result(
          commit === null
            ? "No selected changes to commit"
            : `Committed ${commit}`,
          { commit },
        );
      }
      case "undo": {
        const repository = this.#context.repository;
        if (repository === undefined)
          throw new Error("Undo requires Git integration");
        const pending = await repository.lastPatchCommit();
        const selected = new Set(state.editablePaths);
        if (pending.paths.some((path) => !selected.has(path))) {
          throw new Error(
            "The last Patch commit includes paths outside the editable selection",
          );
        }
        const undone = await repository.undoLastPatchCommit();
        return result(`Undid ${undone.commit}`, { changedPaths: undone.paths });
      }
      case "clipboard-copy": {
        const content = [...state.messages]
          .reverse()
          .find((message) => message.role === "assistant")?.content;
        if (typeof content !== "string")
          throw new Error("There is no assistant text to copy");
        await this.#context.writeClipboard(content);
        return result("Copied the last assistant response");
      }
      case "clipboard-paste":
        return result(await this.#context.readClipboard());
      case "exit":
        this.close();
        return result("", { exit: true });
      case "switch":
        throw new Error(
          "Internal switch effects are not accepted as slash commands",
        );
    }
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

  async #commit(
    paths: readonly string[],
    message: string,
  ): Promise<string | null> {
    if (!this.#context.bootstrap.arguments.git) return null;
    return (
      (
        await this.#context.repository?.commit({
          paths: [...paths],
          message,
          verify: false,
        })
      )?.commit ?? null
    );
  }

  async #runCheck(
    label: "lint" | "test",
    command: string | undefined,
    signal: AbortSignal,
    changedPaths: readonly string[],
    options: ApplicationSubmitOptions,
  ): Promise<void> {
    if (command === undefined) return;
    options.emit({ type: `${label}-start`, data: { command } });
    const result = await executeModelCommand(
      command,
      { root: this.#context.root, signal },
      { show: () => undefined, approve: () => true },
    );
    options.emit({ type: `${label}-complete`, data: result });
    await this.#commit(changedPaths, `Apply ${label} changes`);
    if (result.status !== "completed" || result.exitCode !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      const outcome =
        result.status === "completed"
          ? `exited with code ${String(result.exitCode)}`
          : `was ${result.status}`;
      throw new Error(
        `Configured ${label} command ${outcome}${output === "" ? "" : `\n\n${output}`}`,
      );
    }
  }
}

export class ConcreteApplicationService implements ApplicationService {
  readonly #context: ApplicationContext;
  readonly #sessions = new Set<ConcreteApplicationSession>();
  #closed = false;

  get root(): string {
    return this.#context.root;
  }

  async isIgnored(path: string): Promise<boolean> {
    return this.#context.repository?.isIgnored(path) ?? false;
  }

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
    const makeProvider = (model: ModelSettings) =>
      options.dependencies?.provider ??
      (options.dependencies?.createProvider ?? createProvider)(model, {
        environment: bootstrap.environment,
      });
    const provider = makeProvider({
      ...models.main.settings,
      editFormat: requestedFormat,
    });
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
      catalog,
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
      makeProvider,
      readClipboard: options.dependencies?.readClipboard ?? readClipboardText,
      writeClipboard:
        options.dependencies?.writeClipboard ?? writeClipboardText,
      ...(repositoryMap === undefined ? {} : { repositoryMap }),
      ...(options.dependencies?.approvePath === undefined
        ? {}
        : { approvePath: options.dependencies.approvePath }),
      ...(options.dependencies?.authorizeWrite === undefined
        ? {}
        : { authorizeWrite: options.dependencies.authorizeWrite }),
      ...(options.dependencies?.approveCommand === undefined
        ? {}
        : { approveCommand: options.dependencies.approveCommand }),
    });
  }

  createSession(_context: {
    readonly principal: string;
    readonly sessionId: string;
  }): ApplicationSession {
    void _context;
    if (this.#closed) throw new Error("Application service is closed");
    const session = new ConcreteApplicationSession(this.#context);
    this.#sessions.add(session);
    return session;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of this.#sessions) session.close();
    await Promise.all(
      [...this.#sessions].map((session) => session.queue.idle()),
    );
    this.#sessions.clear();
    await this.#context.provider.close?.();
  }
}
