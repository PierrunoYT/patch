import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import {
  ConcreteApplicationService,
  type ConcreteApplicationOptions,
} from "./core/concrete-application-service.js";
import { runInput, TerminalInput, type InputDependencies } from "./input.js";
import { TerminalHistory } from "./io/history.js";
import {
  generateShellCompletion,
  notifyUser,
  type CompletionShell,
} from "./io/integrations.js";
import { MarkdownStream, renderDiff, renderEditPreview } from "./io/render.js";
import { sanitizedWriter } from "./io/sanitize.js";
import type { EditPreview } from "./edits/write-boundary.js";
import type { ApplicationSession } from "./core/application-service.js";
import type { AiWatchMode } from "./interfaces/watch-mode.js";
import type { LocalWebServer } from "./interfaces/web-server.js";

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

function append(values: string[], option: string, value: string | undefined) {
  if (value !== undefined) values.push(option, value);
}

function bootstrapArguments(options: ProgramOptions, files: readonly string[]) {
  const argv: string[] = [];
  append(argv, "--config", options.config);
  append(argv, "--env-file", options.envFile);
  append(argv, "--encoding", options.encoding);
  append(argv, "--model", options.model);
  append(argv, "--edit-format", options.editFormat);
  append(argv, "--lint-cmd", options.lintCmd);
  append(argv, "--test-cmd", options.testCmd);
  if (options.git === false) argv.push("--no-git");
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
      .option("--vim", "use Vi input bindings instead of Emacs bindings")
      .option("--editor <command>", "external editor used by Ctrl-X Ctrl-E")
      .option("--no-color", "disable ANSI color and styling")
      .option("--notifications", "notify when a response is ready")
      .option("--notifications-command <command>", "argv notification command")
      .option("-c, --config <path>", "configuration file")
      .option("--env-file <path>", "dotenv file")
      .option("--encoding <encoding>", "text encoding")
      .option("--no-git", "disable Git integration")
      .option("--model <name>", "model name")
      .option("--edit-format <format>", "edit strategy")
      .option("--lint-cmd <command>", "configured lint command")
      .option("--test-cmd <command>", "configured test command")
      .option("--watch-files", "watch AI comments while terminal input is open")
      .option(
        "--web",
        "serve the authenticated loopback HTTP/SSE API instead of terminal input",
      )
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
      .action(async (files: string[], options: ProgramOptions) => {
        if (options.shellCompletions !== undefined) {
          if (!["bash", "zsh", "fish"].includes(options.shellCompletions)) {
            throw new Error(
              `Unsupported completion shell: ${options.shellCompletions}`,
            );
          }
          (dependencies.writeOutput ?? ((text) => process.stdout.write(text)))(
            generateShellCompletion(options.shellCompletions),
          );
          return;
        }
        if (
          options.web !== true &&
          (options.webPort !== undefined || options.webTokenFile !== undefined)
        ) {
          throw new Error("--web-port and --web-token-file require --web");
        }
        if (
          (options.web === true || options.watchFiles === true) &&
          (options.message !== undefined || options.messageFile !== undefined)
        ) {
          throw new Error(
            "Watcher/web startup cannot be combined with one-shot input",
          );
        }
        if (options.web === true && options.watchFiles === true) {
          throw new Error("--web and --watch-files cannot be combined");
        }
        const port = Number(options.webPort ?? "0");
        if (
          options.webPort !== undefined &&
          (!/^\d+$/u.test(options.webPort) ||
            !Number.isInteger(port) ||
            port < 0 ||
            port > 65535)
        ) {
          throw new Error("--web-port must be an integer from 0 to 65535");
        }
        let token: string | undefined;
        if (options.web === true) {
          if (options.webTokenFile === undefined)
            throw new Error("--web requires --web-token-file");
          try {
            token = (
              await readFile(
                resolve(
                  dependencies.cwd ?? process.cwd(),
                  options.webTokenFile,
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
          ...(options.inputHistoryFile === undefined
            ? {}
            : { input: options.inputHistoryFile }),
          ...(options.chatHistoryFile === undefined
            ? {}
            : { chat: options.chatHistoryFile }),
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
        const terminal =
          input.isTTY === true &&
          (dependencies.outputIsTTY ?? process.stdout.isTTY) === true &&
          dependencies.lines === undefined &&
          options.message === undefined &&
          options.messageFile === undefined &&
          options.multiline !== true &&
          options.web !== true &&
          options.watchFiles !== true
            ? new TerminalInput(input, write, signal, () =>
                controller.abort(new Error("Application stopped")),
              )
            : undefined;
        const stop = () => controller.abort(new Error("Application stopped"));
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        let application: ConcreteApplicationService | undefined;
        let session: ApplicationSession | undefined;
        let watcher: AiWatchMode | undefined;
        let web: LocalWebServer | undefined;
        try {
          application =
            dependencies.handleMessage === undefined
              ? await (
                  dependencies.createApplication ??
                  ConcreteApplicationService.create
                )({
                  argv: bootstrapArguments(options, files),
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
                        },
                      }),
                })
              : undefined;
          signal.throwIfAborted();
          if (options.web === true) {
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
                signal.addEventListener("abort", () => done(), { once: true }),
              );
            return;
          }
          session = await application?.createSession({
            principal: "terminal",
            sessionId: "terminal",
          });
          if (options.watchFiles === true) {
            if (application === undefined || session === undefined)
              throw new Error("Watch startup requires an application session");
            const watchApplication = application;
            const { AiWatchMode } = await import("./interfaces/watch-mode.js");
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
                if (event.type === "edit-preview")
                  write(
                    `${renderDiff(renderEditPreview(event.data as EditPreview), { color: false })}\n`,
                  );
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
          await runInput(options, {
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
                        } else if (event.type === "edit-preview") {
                          markdown.end();
                          write(
                            `${renderDiff(
                              renderEditPreview(event.data as EditPreview),
                              renderOptions,
                            )}\n`,
                          );
                        }
                      },
                    })
                  : await dependencies.handleMessage(message);
              if (dependencies.handleMessage === undefined) {
                markdown.end();
                write("\n");
              }
              if (options.notifications === true) {
                await notifyUser(
                  options.notificationsCommand === undefined
                    ? {}
                    : { command: options.notificationsCommand },
                  dependencies.writeOutput === undefined
                    ? {}
                    : { write: dependencies.writeOutput },
                );
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
            recordChat: (role, message) => history.appendChat(role, message),
          });
        } catch (error) {
          if (!signal.aborted) throw error;
        } finally {
          terminal?.close();
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          watcher?.close();
          try {
            await web?.close();
            await session?.close?.();
          } finally {
            await application?.close();
          }
        }
      })
  );
}
