import { Command } from "commander";

import {
  ConcreteApplicationService,
  type ConcreteApplicationOptions,
} from "./core/concrete-application-service.js";
import { runInput, type InputDependencies } from "./input.js";
import { TerminalHistory } from "./io/history.js";
import {
  generateShellCompletion,
  notifyUser,
  type CompletionShell,
} from "./io/integrations.js";

export type ProgramDependencies = Partial<InputDependencies> & {
  readonly writeOutput?: (text: string) => void;
  readonly createApplication?: (
    options: ConcreteApplicationOptions,
  ) => Promise<ConcreteApplicationService>;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
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
  return new Command()
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
    .option("--multiline", "read interactive input through EOF as one message")
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
      const application =
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
            })
          : undefined;
      const session = await application?.createSession({
        principal: "terminal",
        sessionId: "terminal",
      });
      try {
        await runInput(options, {
          handleMessage: async (message) => {
            const controller = new AbortController();
            const response =
              dependencies.handleMessage === undefined
                ? await session?.submit(message, {
                    signal: controller.signal,
                    emit: (event) => {
                      if (
                        event.type === "text-delta" &&
                        typeof event.data === "object" &&
                        event.data !== null &&
                        "text" in event.data
                      ) {
                        write(String(event.data.text));
                      }
                    },
                  })
                : await dependencies.handleMessage(message);
            if (dependencies.handleMessage === undefined) write("\n");
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
              return response.response;
            }
            return undefined;
          },
          ...(dependencies.lines === undefined
            ? {}
            : { lines: dependencies.lines }),
          ...(dependencies.readMessageFile === undefined
            ? {}
            : { readMessageFile: dependencies.readMessageFile }),
          recordInput: (message) => history.appendInput(message),
          recordChat: (role, message) => history.appendChat(role, message),
        });
      } finally {
        await session?.close?.();
        await application?.close();
      }
    });
}
