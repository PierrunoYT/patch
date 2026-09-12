import { Command, Option } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import {
  ConcreteApplicationService,
  type ConcreteApplicationOptions,
} from "./core/concrete-application-service.js";
import { runInput, TerminalInput, type InputDependencies } from "./input.js";
import { COMMAND_NAMES } from "./commands/parse.js";
import { ApplicationEditFormatSchema } from "./edits/types.js";
import { discoverEditor } from "./io/editor.js";
import { TerminalHistory } from "./io/history.js";
import { runInteractiveCommand } from "./process/interactive-command.js";
import {
  generateShellCompletion,
  notifyUser,
  type CompletionShell,
} from "./io/integrations.js";
import {
  MarkdownStream,
  renderCommandResult,
  renderDiff,
  renderEditPreview,
  renderUsage,
} from "./io/render.js";
import type { ModelCommandResult } from "./process/model-command.js";
import type { UsageReport } from "./models/usage.js";
import { sanitizedWriter } from "./io/sanitize.js";
import type { EditPreview } from "./edits/write-boundary.js";
import type { ApplicationSession } from "./core/application-service.js";
import type { AiWatchMode } from "./interfaces/watch-mode.js";
import type { LocalWebServer } from "./interfaces/web-server.js";
import { bootstrapConfiguration } from "./config/bootstrap.js";

export type ProgramDependencies = Partial<InputDependencies> & {
  readonly writeOutput?: (text: string) => void;
  readonly createApplication?: (
    options: ConcreteApplicationOptions,
  ) => Promise<ConcreteApplicationService>;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly outputIsTTY?: boolean;
  readonly inputStream?: Readable & { readonly isTTY?: boolean };
  readonly signal?: AbortSignal;
};

interface ProgramOptions {
  readonly message?: string;
  readonly messageFile?: string;
  readonly inputHistoryFile?: string;
  readonly chatHistoryFile?: string;
  readonly multiline?: boolean;
  readonly vim?: boolean;
  readonly editor?: string;
  readonly color?: boolean;
  readonly notifications?: boolean;
  readonly notificationsCommand?: string;
  readonly shellCompletions?: CompletionShell;
  readonly config?: string;
  readonly envFile?: string;
  readonly encoding?: string;
  readonly git?: boolean;
  readonly gitCommitVerify?: boolean;
  readonly generateCommitMessages?: boolean;
  readonly cacheKeepalivePings?: string;
  readonly commitAuthorName?: string;
  readonly commitCommitterName?: string;
  readonly commitCoAuthor?: string;
  readonly model?: string;
  readonly editFormat?: string;
  readonly lintCmd?: string;
  readonly testCmd?: string;
  readonly file?: string[];
  readonly readOnly?: string[];
  readonly watchFiles?: boolean;
  readonly web?: boolean;
  readonly webPort?: string;
  readonly webTokenFile?: string;
}

/** Current terminal geometry, with the PTY defaults when it is not reported. */
function terminalSize(): { columns: number; rows: number } {
  return {
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

function append(values: string[], option: string, value: string | undefined) {
  if (value !== undefined) values.push(option, value);
}

function bootstrapArguments(
  options: ProgramOptions,
  files: readonly string[],
  command: Command,
) {
  const argv: string[] = [];
  append(argv, "--config", options.config);
  append(argv, "--env-file", options.envFile);
  append(argv, "--encoding", options.encoding);
  append(argv, "--model", options.model);
  append(argv, "--cache-keepalive-pings", options.cacheKeepalivePings);
  append(argv, "--edit-format", options.editFormat);
  append(argv, "--lint-cmd", options.lintCmd);
  append(argv, "--test-cmd", options.testCmd);
  append(argv, "--input-history-file", options.inputHistoryFile);
  append(argv, "--chat-history-file", options.chatHistoryFile);
  append(argv, "--notifications-command", options.notificationsCommand);
  append(argv, "--web-port", options.webPort);
  append(argv, "--web-token-file", options.webTokenFile);
  append(argv, "--commit-author-name", options.commitAuthorName);
  append(argv, "--commit-committer-name", options.commitCommitterName);
  append(argv, "--commit-co-author", options.commitCoAuthor);
  if (command.getOptionValueSource("gitCommitVerify") === "cli")
    argv.push(
      options.gitCommitVerify
        ? "--git-commit-verify"
        : "--no-git-commit-verify",
    );
  if (command.getOptionValueSource("generateCommitMessages") === "cli")
    argv.push(
      options.generateCommitMessages
        ? "--generate-commit-messages"
        : "--no-generate-commit-messages",
    );
  if (options.git === false) argv.push("--no-git");
  for (const [name, enabled, option] of [
    ["multiline", options.multiline, "--multiline"],
    ["notifications", options.notifications, "--notifications"],
    ["watchFiles", options.watchFiles, "--watch-files"],
    ["web", options.web, "--web"],
  ] as const) {
    if (command.getOptionValueSource(name) === "cli")
      argv.push(enabled === true ? option : `--no-${option.slice(2)}`);
  }
  for (const path of options.file ?? []) argv.push("--file", path);
  for (const path of options.readOnly ?? []) argv.push("--read-only", path);
  argv.push("--", ...files);
  return argv;
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const writeOut =
    dependencies.writeOutput ?? ((text: string) => process.stdout.write(text));
  return (
    new Command()
      // Usage and error text can quote untrusted arguments, paths, and command
      // output, so both program streams pass through the shared sanitizer.
      .configureOutput({
        writeOut: sanitizedWriter(writeOut),
        writeErr: sanitizedWriter((text) => void process.stderr.write(text)),
      })
      .name("patch")
      .description("AI pair programming in your terminal")
      .argument("[files...]", "repository files to edit")
      .option("-m, --message <text>", "send one message and exit")
      .option(
        "-f, --message-file <path>",
        "send a message read from a file and exit",
      )
      .option(
        "--input-history-file <path>",
        "append submitted input as JSON Lines",
      )
      .option("--chat-history-file <path>", "write chat Markdown to this path")
      .option(
        "--multiline",
        "read interactive input through EOF as one message",
      )
      .option("--no-multiline", "disable configured multiline input")
      // Registered, but hidden from help and completion: it exists only so the
      // flag fails with its reason instead of a bare "unknown option".
      .addOption(
        new Option(
          "--vim",
          "(unsupported) Vi modal input is not implemented",
        ).hideHelp(),
      )
      .option("--editor <command>", "external editor used by Ctrl-X Ctrl-E")
      .option("--no-color", "disable ANSI color and styling")
      .option("--notifications", "notify when a response is ready")
      .option("--no-notifications", "disable configured notifications")
      .option("--notifications-command <command>", "argv notification command")
      .option("-c, --config <path>", "configuration file")
      .option("--env-file <path>", "dotenv file")
      .option("--encoding <encoding>", "text encoding")
      .option("--no-git", "disable Git integration")
      .option("--git-commit-verify", "run Git commit hooks (default: disabled)")
      .option(
        "--no-git-commit-verify",
        "skip Git pre-commit and commit-msg hooks",
      )
      .option(
        "--generate-commit-messages",
        "generate messages from selected diffs with the weak model (opt-in)",
      )
      .option(
        "--no-generate-commit-messages",
        "use fixed commit messages without provider calls",
      )
      .option(
        "--commit-author-name <name>",
        "explicit Git author name for Patch-authored edits",
      )
      .option(
        "--commit-committer-name <name>",
        "explicit Git committer name for all Patch commits",
      )
      .option(
        "--commit-co-author <identity>",
        "co-author trailer for Patch-authored edits",
      )
      .option("--model <name>", "model name")
      .option(
        "--cache-keepalive-pings <count>",
        "refresh a supported prompt cache up to 10 times (default: 0)",
      )
      .option("--edit-format <format>", "edit strategy")
      .option("--lint-cmd <command>", "configured lint command")
      .option("--test-cmd <command>", "configured test command")
      .option("--watch-files", "watch AI comments while terminal input is open")
      .option("--no-watch-files", "disable configured file watching")
      .option(
        "--web",
        "serve the authenticated loopback HTTP/SSE API instead of terminal input",
      )
      .option("--no-web", "disable the configured HTTP/SSE API")
      .option("--web-port <port>", "HTTP port (default: an available port)")
      .option(
        "--web-token-file <path>",
        "file containing a secret bearer token (required with --web)",
      )
      .option(
        "--file <path>",
        "editable file (repeatable)",
        (path, paths: string[]) => [...paths, path],
        [],
      )
      .option(
        "--read-only <path>",
        "read-only file (repeatable)",
        (path, paths: string[]) => [...paths, path],
        [],
      )
      .option(
        "--shell-completions <shell>",
        "print bash, zsh, or fish completions",
      )
      .showHelpAfterError()
      .action(
        async (files: string[], options: ProgramOptions, self: Command) => {
          if (options.shellCompletions !== undefined) {
            if (!["bash", "zsh", "fish"].includes(options.shellCompletions)) {
              throw new Error(
                `Unsupported completion shell: ${options.shellCompletions}`,
              );
            }
            (
              dependencies.writeOutput ?? ((text) => process.stdout.write(text))
            )(
              // The options this parser registered, so the script cannot advertise
              // a flag that was removed or miss one that was added.
              generateShellCompletion(options.shellCompletions, [
                ...self.options
                  .filter((option) => !option.hidden)
                  .map((option) => option.long ?? ""),
                "--help",
              ]),
            );
            return;
          }
          // Refused rather than ignored: Node readline has no modal editing, and
          // accepting the flag would imply bindings that are simply absent.
          if (options.vim === true) {
            throw new Error(
              "--vim is not implemented: Patch's line reader has no modal editing. Remove the flag; Ctrl-X Ctrl-E opens $EDITOR instead.",
            );
          }
          const bootstrap = await bootstrapConfiguration({
            argv: bootstrapArguments(options, files, self),
            ...(dependencies.cwd === undefined
              ? {}
              : { cwd: dependencies.cwd }),
            ...(dependencies.environment === undefined
              ? {}
              : { environment: dependencies.environment }),
          });
          const configured = bootstrap.arguments;
          if (
            configured.web !== true &&
            (configured.webPort !== 0 || configured.webTokenFile !== undefined)
          ) {
            throw new Error("web-port and web-token-file require web");
          }
          if (
            (configured.web === true || configured.watchFiles === true) &&
            (options.message !== undefined || options.messageFile !== undefined)
          ) {
            throw new Error(
              "Watcher/web startup cannot be combined with one-shot input",
            );
          }
          if (configured.web === true && configured.watchFiles === true) {
            throw new Error("web and watch-files cannot be combined");
          }
          const port = configured.webPort;
          let token: string | undefined;
          if (configured.web === true) {
            if (configured.webTokenFile === undefined)
              throw new Error("web requires web-token-file");
            try {
              token = (
                await readFile(
                  resolve(
                    dependencies.cwd ?? process.cwd(),
                    configured.webTokenFile,
                  ),
                  "utf8",
                )
              ).trim();
            } catch {
              throw new Error("Unable to read --web-token-file");
            }
            if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token))
              throw new Error(
                "Web token must contain 32–256 letters, digits, underscores or hyphens; generate a random token",
              );
          }
          const history = new TerminalHistory({
            ...(configured.inputHistoryFile === undefined
              ? {}
              : { input: configured.inputHistoryFile }),
            ...(configured.chatHistoryFile === undefined
              ? {}
              : { chat: configured.chatHistoryFile }),
          });
          const write =
            dependencies.writeOutput ??
            ((text: string) => process.stdout.write(text));
          const controller = new AbortController();
          const signal =
            dependencies.signal === undefined
              ? controller.signal
              : AbortSignal.any([controller.signal, dependencies.signal]);
          const input = dependencies.inputStream ?? process.stdin;
          let application: ConcreteApplicationService | undefined;
          let session: ApplicationSession | undefined;
          const terminal =
            input.isTTY === true &&
            (dependencies.outputIsTTY ?? process.stdout.isTTY) === true &&
            dependencies.lines === undefined &&
            options.message === undefined &&
            options.messageFile === undefined &&
            configured.multiline !== true &&
            configured.web !== true &&
            configured.watchFiles !== true
              ? new TerminalInput(
                  input,
                  write,
                  signal,
                  () => controller.abort(new Error("Application stopped")),
                  {
                    // Read per keystroke so completion reflects the files selected
                    // now, not those selected at startup.
                    completionSources: async () => {
                      const state = session?.snapshot() as
                        | {
                            editablePaths?: readonly string[];
                            readOnlyPaths?: readonly string[];
                          }
                        | undefined;
                      const approved = await session?.completionCandidates?.();
                      return {
                        commands: COMMAND_NAMES,
                        modes: ["code", ...ApplicationEditFormatSchema.options],
                        files: [
                          ...new Set([
                            ...(approved?.files ?? []),
                            ...(state?.editablePaths ?? []),
                            ...(state?.readOnlyPaths ?? []),
                          ]),
                        ],
                        identifiers: approved?.identifiers ?? [],
                      };
                    },
                    // Recall is opt-in: without a configured history file there is
                    // nothing to read, and nothing is written either.
                    ...(configured.inputHistoryFile === undefined
                      ? {}
                      : { history: await history.readInput() }),
                    editor:
                      options.editor ??
                      discoverEditor(dependencies.environment ?? process.env),
                  },
                )
              : undefined;
          const stop = () => controller.abort(new Error("Application stopped"));
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
          let watcher: AiWatchMode | undefined;
          let web: LocalWebServer | undefined;
          try {
            application =
              dependencies.handleMessage === undefined
                ? await (
                    dependencies.createApplication ??
                    ConcreteApplicationService.create
                  )({
                    bootstrap,
                    ...(dependencies.cwd === undefined
                      ? {}
                      : { cwd: dependencies.cwd }),
                    ...(dependencies.environment === undefined
                      ? {}
                      : { environment: dependencies.environment }),
                    ...(terminal === undefined
                      ? {}
                      : {
                          dependencies: {
                            authorizeWrite: (request) =>
                              terminal.confirm(
                                `Allow ${request.operation.kind} (${request.reason}) at repository-relative path`,
                                request.path,
                              ),
                            approveCommand: (command) =>
                              terminal.confirm(
                                "Run shell command at repository root (not sandboxed)",
                                command,
                              ),
                            // Only a real terminal can hand over the keyboard, so
                            // only this startup shape offers interactive dispatch.
                            runInteractiveCommand: (command, commandOptions) =>
                              terminal.suspend((raw) =>
                                runInteractiveCommand(command, {
                                  root: commandOptions.root,
                                  input: raw,
                                  write,
                                  environment:
                                    dependencies.environment ?? process.env,
                                  ...(commandOptions.signal === undefined
                                    ? {}
                                    : { signal: commandOptions.signal }),
                                  ...terminalSize(),
                                  onResize: (listener) => {
                                    const notify = () =>
                                      listener(terminalSize());
                                    process.stdout.on("resize", notify);
                                    return () =>
                                      void process.stdout.off("resize", notify);
                                  },
                                }),
                              ),
                          },
                        }),
                  })
                : undefined;
            signal.throwIfAborted();
            if (configured.web === true) {
              if (application === undefined || token === undefined)
                throw new Error("Web startup requires an application service");
              const { LocalWebServer } =
                await import("./interfaces/web-server.js");
              web = new LocalWebServer({
                service: application,
                tokens: { [token]: "local" },
                port,
              });
              const address = await web.start();
              write(
                `Patch HTTP API listening on http://${address.host}:${address.port}\n`,
              );
              if (!signal.aborted)
                await new Promise<void>((done) =>
                  signal.addEventListener("abort", () => done(), {
                    once: true,
                  }),
                );
              return;
            }
            session = await application?.createSession({
              principal: "terminal",
              sessionId: "terminal",
            });
            if (configured.watchFiles === true) {
              if (application === undefined || session === undefined)
                throw new Error(
                  "Watch startup requires an application session",
                );
              const watchApplication = application;
              const { AiWatchMode } =
                await import("./interfaces/watch-mode.js");
              const markdown = new MarkdownStream(write, { color: false });
              watcher = new AiWatchMode({
                root: application.root,
                session,
                signal,
                isIgnored: (path) => watchApplication.isIgnored(path),
                emit: (event) => {
                  if (
                    event.type === "text-delta" &&
                    typeof event.data === "object" &&
                    event.data !== null &&
                    "text" in event.data
                  )
                    markdown.write(String(event.data.text));
                  if (event.type === "finish") {
                    markdown.end();
                    write("\n");
                  }
                  if (event.type === "commit-message-usage")
                    write(
                      `Commit message: ${renderUsage(event.data as UsageReport, undefined, { color: false })}\n`,
                    );
                  if (event.type === "edit-preview")
                    write(
                      `${renderDiff(renderEditPreview(event.data as EditPreview), { color: false })}\n`,
                    );
                  if (
                    event.type === "command-complete" ||
                    event.type === "lint-complete" ||
                    event.type === "test-complete"
                  ) {
                    markdown.end();
                    write(
                      `${renderCommandResult(event.data as ModelCommandResult, {
                        color: false,
                      })}\n`,
                    );
                  }
                },
                selectedPaths: () => {
                  const state = session?.snapshot() as
                    { editablePaths?: readonly string[] } | undefined;
                  return state?.editablePaths ?? [];
                },
                onError: (error, source) => {
                  markdown.end();
                  write(
                    `${source === "watcher" ? "Watch mode stopped" : "Watched turn failed"}: ${
                      error instanceof Error ? error.message : String(error)
                    }\n`,
                  );
                },
              });
              await watcher.start();
            }
            await runInput(
              { ...options, multiline: configured.multiline },
              {
                signal,
                handleMessage: async (message) => {
                  const renderOptions = {
                    ...(options.color === false ? { color: false } : {}),
                    environment: dependencies.environment ?? process.env,
                    isTTY: dependencies.outputIsTTY ?? process.stdout.isTTY,
                  };
                  const markdown = new MarkdownStream(write, renderOptions);
                  const response =
                    dependencies.handleMessage === undefined
                      ? await session?.submit(message, {
                          signal,
                          emit: (event) => {
                            if (
                              event.type === "text-delta" &&
                              typeof event.data === "object" &&
                              event.data !== null &&
                              "text" in event.data
                            ) {
                              markdown.write(String(event.data.text));
                            } else if (event.type === "commit-message-usage") {
                              markdown.end();
                              write(
                                `Commit message: ${renderUsage(event.data as UsageReport, undefined, renderOptions)}\n`,
                              );
                            } else if (event.type === "edit-preview") {
                              markdown.end();
                              write(
                                `${renderDiff(
                                  renderEditPreview(event.data as EditPreview),
                                  renderOptions,
                                )}\n`,
                              );
                            } else if (
                              event.type === "command-complete" ||
                              event.type === "lint-complete" ||
                              event.type === "test-complete"
                            ) {
                              // Approving or configuring a command and then seeing
                              // nothing hides both its output and its status.
                              markdown.end();
                              write(
                                `${renderCommandResult(
                                  event.data as ModelCommandResult,
                                  renderOptions,
                                )}\n`,
                              );
                            }
                          },
                        })
                      : await dependencies.handleMessage(message);
                  const turn =
                    typeof response === "object" && response !== null
                      ? (response as {
                          usage?: UsageReport;
                          sessionCost?: number;
                          kind?: "turn" | "command";
                        })
                      : undefined;
                  const turnKind = turn?.kind;
                  if (dependencies.handleMessage === undefined) {
                    markdown.end();
                    write("\n");
                    if (turn?.usage !== undefined) {
                      write(
                        `${renderUsage(turn.usage, turn.sessionCost, renderOptions)}\n`,
                      );
                    }
                  }
                  // A slash command answers immediately; only a provider turn is
                  // worth interrupting the user for. A notification command that
                  // fails is reported, never allowed to end the input loop.
                  if (
                    configured.notifications === true &&
                    turnKind !== "command"
                  ) {
                    try {
                      await notifyUser(
                        configured.notificationsCommand === undefined
                          ? {}
                          : { command: configured.notificationsCommand },
                        dependencies.writeOutput === undefined
                          ? {}
                          : { write: dependencies.writeOutput },
                      );
                    } catch (error) {
                      write(
                        `Notification failed: ${
                          error instanceof Error ? error.message : String(error)
                        }\n`,
                      );
                    }
                  }
                  if (typeof response === "string") return response;
                  if (
                    typeof response === "object" &&
                    response !== null &&
                    "response" in response &&
                    typeof response.response === "string"
                  ) {
                    return {
                      response: response.response,
                      ...("exit" in response && response.exit === true
                        ? { exit: true }
                        : {}),
                    };
                  }
                  return undefined;
                },
                ...(terminal !== undefined
                  ? { lines: terminal }
                  : dependencies.lines === undefined
                    ? {}
                    : { lines: dependencies.lines }),
                ...(dependencies.readMessageFile === undefined
                  ? {}
                  : { readMessageFile: dependencies.readMessageFile }),
                recordInput: (message) => history.appendInput(message),
                recordChat: (role, message) =>
                  history.appendChat(role, message),
              },
            );
          } catch (error) {
            if (!signal.aborted) throw error;
          } finally {
            terminal?.close();
            process.off("SIGINT", stop);
            process.off("SIGTERM", stop);
            await watcher?.close();
            try {
              await web?.close();
              await session?.close?.();
            } finally {
              await application?.close();
            }
          }
        },
      )
  );
}
