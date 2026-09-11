/**
 * Turn ordering adapted from aider/coders/base_coder.py at revision
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c.
 * Modified for Patch's composed adapters, serial queue, strict authorization,
 * fresh-snapshot reflection, and explicit partial-write recovery limits.
 * Licensed under the Apache License, Version 2.0.
 */

import { realpath, stat } from "node:fs/promises";
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
import {
  resolveEditBatch,
  EditResolutionError,
  type FileSnapshot,
} from "../edits/resolve.js";
import { EditTransaction } from "../edits/transaction.js";
import type { EditFormat } from "../edits/types.js";
import {
  applyAuthorizedEdits,
  type WriteAuthorizationRequest,
} from "../edits/write-boundary.js";
import { selectFence } from "./fences.js";
import { FileSystemAdapter } from "../io/filesystem.js";
import { readClipboardText, writeClipboardText } from "../io/integrations.js";
import { isMissingPathError, SafePathResolver } from "../io/safe-path.js";
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
import {
  worktreeMutationLock,
  type WorktreeMutationLock,
} from "./worktree-lock.js";

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
  /** Shared by every session on this worktree; see `worktree-lock.ts`. */
  readonly worktree: WorktreeMutationLock;
  readonly approvePath?: (path: string) => boolean | Promise<boolean>;
  readonly authorizeWrite?: (
    request: WriteAuthorizationRequest,
  ) => boolean | Promise<boolean>;
  readonly approveCommand?: (command: string) => boolean | Promise<boolean>;
  readonly makeProvider: (model: ModelSettings) => ModelProvider;
  readonly readClipboard: () => Promise<string>;
  readonly writeClipboard: (text: string) => Promise<void>;
}

/**
 * Everything a turn derives from the active model and edit format. It is replaced
 * as one value so a switch cannot leave prompts, shell policy, fence, or map policy
 * describing a model that is no longer active.
 */
interface SessionProfile {
  /** Active main model settings, before the active format is applied. */
  readonly main: ModelSettings;
  /** Format `/chat-mode code` returns to for the active model. */
  readonly codeFormat: EditFormat;
  readonly definition: StrategyDefinition;
  readonly fence: readonly [string, string];
  readonly repositoryMap?: RepositoryMap;
}

/**
 * Git integration is on by default, so startup outside a worktree has to say what
 * to do about it rather than surfacing a bare `git rev-parse` failure.
 */
async function openWorktree(root: string): Promise<GitRepository> {
  try {
    return await GitRepository.open(root);
  } catch (error) {
    throw new Error(
      `Patch could not open a Git worktree at ${root}. Start Patch inside an existing worktree with Git installed, or pass --no-git to run without Git integration.`,
      { cause: error },
    );
  }
}

function createRepositoryMap(root: string): Promise<RepositoryMap> {
  return RepositoryMap.create({
    root,
    maxTokens: 1024,
    countTokens: (text) => Math.ceil(text.length / 4),
  });
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

/**
 * Directory selection is not implemented, so a directory is rejected here rather
 * than surfacing as an `EISDIR` read failure once a turn tries to snapshot it.
 */
async function assertNotDirectory(
  absolute: string,
  requested: string,
): Promise<void> {
  let directory = false;
  try {
    directory = (await stat(absolute)).isDirectory();
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  if (directory) {
    throw new Error(
      `Patch selects files, not directories: ${requested}. Name the files inside it instead.`,
    );
  }
}

async function selectedPaths(
  resolver: SafePathResolver,
  paths: readonly string[],
): Promise<string[]> {
  const selected: string[] = [];
  for (const path of paths) {
    const absolute = await resolver.resolve(path);
    const normalized = portablePath(resolver.root, absolute);
    if (normalized === "") throw new Error("The repository root is not a file");
    await assertNotDirectory(absolute, path);
    if (!selected.includes(normalized)) selected.push(normalized);
  }
  return selected;
}

async function assertPathsNotIgnored(
  repository: GitRepository | undefined,
  paths: readonly string[],
): Promise<void> {
  if (repository === undefined || paths.length === 0) return;
  const visible = new Set(await repository.filterIgnored(paths));
  const ignored = paths.find((path) => !visible.has(path));
  if (ignored !== undefined) {
    throw new Error(
      `Path is ignored and cannot enter model context: ${ignored}`,
    );
  }
}

async function snapshot(
  files: FileSystemAdapter,
  path: string,
): Promise<FileSnapshot> {
  try {
    return { path, content: (await files.readText(path)).content };
  } catch (error) {
    if (isMissingPathError(error)) return { path, content: null };
    throw error;
  }
}

function fileMessage(
  prefix: string,
  values: readonly FileSnapshot[],
  fence: readonly [string, string],
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
        .map(
          ({ path, content }) => `${path}\n${fence[0]}\n${content}${fence[1]}`,
        )
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
  #profile: SessionProfile;
  #closed = false;

  constructor(context: ApplicationContext) {
    this.#context = context;
    const model = {
      ...context.models.main.settings,
      editFormat: context.definition.strategy.format,
    };
    this.#profile = {
      main: context.models.main.settings,
      codeFormat: context.definition.strategy.format,
      definition: context.definition,
      fence: context.fence,
      ...(context.repositoryMap === undefined
        ? {}
        : { repositoryMap: context.repositoryMap }),
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
        return context.approvePath?.(path) ?? false;
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
      if (effect.type === "clipboard-paste") {
        // Clipboard text becomes the user turn verbatim. It is never reparsed as
        // a command, so clipboard content a user did not write cannot dispatch
        // `/run`, `/undo`, or any other effect.
        message = await this.#context.readClipboard();
        if (message.trim() === "")
          throw new Error("The clipboard has no text to submit");
      } else if (effect.type !== "submit") {
        return this.#dispatch(effect, options);
      } else {
        message = effect.message;
      }
      const changedPaths = new Set<string>();
      const commands: ModelCommandResult[] = [];
      let snapshots: readonly FileSnapshot[] = [];
      const context = async () => {
        const state = this.#session.snapshot();
        const editablePaths = [
          ...new Set([...state.editablePaths, ...changedPaths]),
        ];
        await assertPathsNotIgnored(this.#context.repository, [
          ...editablePaths,
          ...state.readOnlyPaths,
        ]);
        const editable = await Promise.all(
          editablePaths.map((path) => snapshot(this.#context.files, path)),
        );
        const readOnly = await Promise.all(
          state.readOnlyPaths.map((path) =>
            snapshot(this.#context.files, path),
          ),
        );
        const selectedPaths = new Set(
          [...editable, ...readOnly].map(({ path }) => path),
        );
        const availablePaths =
          this.#context.repository === undefined
            ? this.#context.availablePaths
            : await this.#context.repository.filterIgnored(
                this.#context.availablePaths,
              );
        const unselected = await Promise.all(
          availablePaths
            .filter((path) => !selectedPaths.has(path))
            .map((path) => snapshot(this.#context.files, path)),
        );
        snapshots = [...editable, ...readOnly, ...unselected];
        const repositoryContent = await this.#repositoryContext(message);
        const prompt = {
          system: [
            {
              role: "system" as const,
              content: this.#profile.definition.systemPrompt,
            },
          ],
          examples: [
            ...COMMON_PROMPTS.exampleMessages,
            ...this.#profile.definition.examples,
          ],
          readOnlyFiles: fileMessage(
            COMMON_PROMPTS.readOnlyFilesPrefix,
            readOnly,
            this.#profile.fence,
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
          editableFiles: fileMessage(
            COMMON_PROMPTS.filesContentPrefix,
            editable,
            this.#profile.fence,
          ),
          reminder: [
            {
              role: "system" as const,
              content: `${this.#profile.definition.reminder}\n${
                this.#profile.definition.allowShellCommands
                  ? "Shell commands may be suggested only in fenced shell blocks; execution always requires approval."
                  : "Do not suggest shell commands."
              }`,
            },
          ],
        };
        return { prompt, snapshots };
      };
      const completed = await this.#session
        .runTurn(message, {
          signal: options.signal,
          onEvent: (event) => options.emit({ type: event.type, data: event }),
          lifecycle: {
            context,
            // The mutation phase runs under the worktree lock so a second
            // session on this checkout cannot interleave its checkpoint,
            // apply, commit, or checks with this one. Streaming stays outside
            // the lock.
            apply: (candidate) =>
              this.#context.worktree.run(async () => {
                if (options.readOnly === true) {
                  return undefined;
                }
                const editPaths = candidate.edits.edits.flatMap((edit) =>
                  edit.kind === "move"
                    ? [edit.fromPath, edit.path]
                    : [edit.path],
                );
                const resolver = await SafePathResolver.create(
                  this.#context.root,
                );
                const canonicalEditPaths: string[] = [];
                for (const path of editPaths) {
                  const canonical = portablePath(
                    this.#context.root,
                    await resolver.resolve(path),
                  );
                  canonicalEditPaths.push(canonical);
                  if (
                    this.#session.snapshot().readOnlyPaths.includes(canonical)
                  ) {
                    throw new Error("Cannot edit a read-only path");
                  }
                }
                await assertPathsNotIgnored(
                  this.#context.repository,
                  canonicalEditPaths,
                );
                const expandedSnapshots = [...snapshots];
                for (const path of editPaths) {
                  if (!expandedSnapshots.some((file) => file.path === path)) {
                    expandedSnapshots.push(
                      await snapshot(this.#context.files, path),
                    );
                  }
                }
                let resolved;
                try {
                  resolved = resolveEditBatch(
                    candidate.edits,
                    expandedSnapshots,
                  );
                } catch (error) {
                  if (!(error instanceof EditResolutionError)) throw error;
                  return {
                    source: "malformed" as const,
                    diagnostic: `${error.message}: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
                  };
                }
                if (
                  resolved.operations.length === 0 &&
                  resolved.shellCommands.length === 0
                ) {
                  if (changedPaths.size === 0) return undefined;
                }

                const transaction = await EditTransaction.stage(
                  this.#context.files,
                  resolved,
                );
                const repository = this.#context.repository;
                const write = await applyAuthorizedEdits(
                  transaction,
                  this.#session.snapshot().editablePaths,
                  {
                    presentPreview: (preview) =>
                      options.emit({ type: "edit-preview", data: preview }),
                    authorize: (request) =>
                      this.#context.authorizeWrite?.(request) ?? false,
                    isDirty: (path) => repository?.isDirty(path) ?? false,
                    checkpointDirty: async (paths) =>
                      (await this.#commit(
                        paths,
                        "Checkpoint before Patch edits",
                      )) ?? undefined,
                  },
                  options.signal,
                );
                for (const path of write.changedPaths) changedPaths.add(path);
                options.signal.throwIfAborted();
                await this.#commit(write.changedPaths, "Apply Patch edits");
                const signal = options.signal;
                signal.throwIfAborted();
                const lint = await this.#runCheck(
                  "lint",
                  this.#context.bootstrap.arguments.lintCommand,
                  signal,
                  [...changedPaths],
                  options,
                );
                if (lint !== undefined)
                  return { source: "lint" as const, diagnostic: lint };
                commands.push(
                  ...(await executeModelCommands(
                    resolved.shellCommands,
                    { root: this.#context.root, signal },
                    {
                      show: (command) =>
                        options.emit({
                          type: "command-preview",
                          data: { command },
                        }),
                      approve: (command) =>
                        this.#context.approveCommand?.(command) ?? false,
                    },
                  )),
                );
                signal.throwIfAborted();
                const test = await this.#runCheck(
                  "test",
                  this.#context.bootstrap.arguments.testCommand,
                  signal,
                  [...changedPaths],
                  options,
                );
                if (test !== undefined)
                  return { source: "test" as const, diagnostic: test };
                return undefined;
              }, options.signal),
          },
        })
        .finally(() => {
          const state = this.#session.snapshot();
          this.#session.setSelectedPaths(
            [...new Set([...state.editablePaths, ...changedPaths])],
            state.readOnlyPaths,
          );
        });
      const state = this.#session.snapshot();
      return {
        response: completed.response,
        changedPaths: [...changedPaths],
        commit: changedPaths.size === 0 ? null : state.lastPatchCommit,
        commands,
      };
    }, options.signal);
  }

  close(): void {
    this.#closed = true;
    this.#lifecycle.abort(new Error("Application session closed"));
  }

  async #dispatch(
    effect: Exclude<
      CommandEffect,
      { type: "submit" } | { type: "clipboard-paste" }
    >,
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
    const selectable = async (paths: readonly string[]) =>
      selectedPaths(resolver, paths);
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
        const paths = await selectable(effect.paths);
        await assertPathsNotIgnored(this.#context.repository, paths);
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
        const paths = await selectable(effect.paths);
        await assertPathsNotIgnored(this.#context.repository, paths);
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
        await this.#switchProfile(
          resolved.settings,
          resolved.settings.editFormat,
          resolved.settings.editFormat,
        );
        return result(`Model: ${resolved.canonicalName}`);
      }
      case "chat-mode": {
        const format =
          effect.mode === "code" ? this.#profile.codeFormat : effect.mode;
        await this.#switchProfile(
          this.#profile.main,
          format,
          this.#profile.codeFormat,
        );
        return result(`Chat mode: ${format}`);
      }
      case "run": {
        // An approved command may mutate the worktree.
        const command = await this.#context.worktree.run(
          () =>
            executeModelCommand(
              effect.command,
              { root: this.#context.root, signal: options.signal },
              {
                show: (command) =>
                  options.emit({ type: "command-preview", data: { command } }),
                approve: (command) =>
                  this.#context.approveCommand?.(command) ?? false,
              },
            ),
          options.signal,
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
        const diagnostic = await this.#runCheck(
          effect.type,
          command,
          options.signal,
          state.editablePaths,
          options,
        );
        if (diagnostic !== undefined) throw new Error(diagnostic);
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
        const owned = state.lastPatchCommit;
        if (owned === null)
          throw new Error("This session has no Patch commit to undo");
        // Ownership is checked and acted on under one worktree lock so a
        // concurrent session cannot commit between the two operations; the
        // reset itself still compares and swaps HEAD.
        const undone = await this.#context.worktree.run(async () => {
          const pending = await repository.lastPatchCommit();
          if (pending.commit !== owned)
            throw new Error(
              `The last Patch commit ${pending.commit} was not created by this session`,
            );
          const selected = new Set(state.editablePaths);
          if (pending.paths.some((path) => !selected.has(path))) {
            throw new Error(
              "The last Patch commit includes paths outside the editable selection",
            );
          }
          return repository.undoLastPatchCommit(owned);
        }, options.signal);
        this.#session.recordApplied();
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
      case "exit":
        this.close();
        return result("", { exit: true });
      case "switch":
        throw new Error(
          "Internal switch effects are not accepted as slash commands",
        );
    }
  }

  /**
   * Rebuilds every model-derived input and installs it only once the session has
   * accepted the switch, so a rejected or failed switch leaves the previous model,
   * prompts, shell policy, fence, and map policy in place.
   */
  async #switchProfile(
    main: ModelSettings,
    format: EditFormat,
    codeFormat: EditFormat,
  ): Promise<void> {
    const definition = createStrategy(format);
    const model = { ...main, editFormat: format };
    const provider = this.#context.makeProvider(model);
    const state = this.#session.snapshot();
    const contents = await Promise.all(
      [...state.editablePaths, ...state.readOnlyPaths].map((path) =>
        snapshot(this.#context.files, path),
      ),
    );
    const fence = selectFence(
      contents.flatMap(({ content }) => (content === null ? [] : [content])),
    ).fence;
    const repositoryMap = await this.#selectRepositoryMap(main.useRepoMap);
    await this.#session.switch({
      model,
      provider,
      strategy: definition.strategy,
      fence,
    });
    this.#profile = {
      main,
      codeFormat,
      definition,
      fence,
      ...(repositoryMap === undefined ? {} : { repositoryMap }),
    };
  }

  async #selectRepositoryMap(
    useRepoMap: boolean,
  ): Promise<RepositoryMap | undefined> {
    if (!useRepoMap || this.#context.repository === undefined) return undefined;
    return (
      this.#profile.repositoryMap ??
      this.#context.repositoryMap ??
      (await createRepositoryMap(this.#context.root))
    );
  }

  async #repositoryContext(message: string): Promise<string> {
    const map = this.#profile.repositoryMap;
    if (map === undefined) return "";
    const availablePaths =
      this.#context.repository === undefined
        ? this.#context.availablePaths
        : await this.#context.repository.filterIgnored(
            this.#context.availablePaths,
          );
    const selected = new Set([
      ...this.#session.snapshot().editablePaths,
      ...this.#session.snapshot().readOnlyPaths,
    ]);
    const mentionedPaths = availablePaths.filter((path) =>
      message.includes(path),
    );
    return map.getMap({
      chatPaths: [...selected],
      otherPaths: availablePaths.filter((path) => !selected.has(path)),
      mentionedPaths,
      mentionedIdentifiers: identifierHints(message),
    });
  }

  async #commit(
    paths: readonly string[],
    message: string,
  ): Promise<string | null> {
    if (!this.#context.bootstrap.arguments.git || paths.length === 0)
      return null;
    return this.#context.worktree.run(async () => {
      const commit =
        (
          await this.#context.repository?.commit({
            paths: [...paths],
            message,
            verify: false,
          })
        )?.commit ?? null;
      if (commit !== null) this.#session.recordCommit(commit);
      return commit;
    });
  }

  async #runCheck(
    label: "lint" | "test",
    command: string | undefined,
    signal: AbortSignal,
    changedPaths: readonly string[],
    options: ApplicationSubmitOptions,
  ): Promise<string | undefined> {
    if (command === undefined) return;
    signal.throwIfAborted();
    // A configured check observes and can rewrite the working tree, so it runs
    // under the same worktree lock as the edits it checks.
    return this.#context.worktree.run(async () => {
      options.emit({ type: `${label}-start`, data: { command } });
      const result = await executeModelCommand(
        command,
        { root: this.#context.root, signal },
        { show: () => undefined, approve: () => true },
      );
      options.emit({ type: `${label}-complete`, data: result });
      signal.throwIfAborted();
      await this.#commit(changedPaths, `Apply ${label} changes`);
      if (result.status !== "completed" || result.exitCode !== 0) {
        const output = [result.stdout, result.stderr]
          .filter(Boolean)
          .join("\n");
        const outcome =
          result.status === "completed"
            ? `exited with code ${String(result.exitCode)}`
            : `was ${result.status}`;
        return `Configured ${label} command ${outcome}${output === "" ? "" : `\n\n${output}`}`;
      }
      return undefined;
    }, signal);
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
    const repository = bootstrap.arguments.git
      ? await openWorktree(root)
      : undefined;
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
    await assertPathsNotIgnored(repository, [
      ...editablePaths,
      ...readOnlyPaths,
    ]);
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
    const availablePaths =
      repository === undefined
        ? [...new Set([...editablePaths, ...readOnlyPaths])]
        : await repository.filterIgnored(
            (await repository.status()).trackedPaths,
          );
    const repositoryMap =
      models.main.settings.useRepoMap && repository !== undefined
        ? await createRepositoryMap(root)
        : undefined;
    return new ConcreteApplicationService({
      bootstrap,
      catalog,
      root,
      worktree: worktreeMutationLock(root),
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
