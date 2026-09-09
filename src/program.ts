import { Command } from "commander";

import { runInput, type InputDependencies } from "./input.js";
import { TerminalHistory } from "./io/history.js";
import {
  generateShellCompletion,
  notifyUser,
  type CompletionShell,
} from "./io/integrations.js";

export type ProgramDependencies = Partial<InputDependencies> & {
  readonly writeOutput?: (text: string) => void;
};

async function unavailableProvider(): Promise<never> {
  throw new Error("No model provider is configured");
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  return new Command()
    .name("patch")
    .description("AI pair programming in your terminal")
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
    .option(
      "--shell-completions <shell>",
      "print bash, zsh, or fish completions",
    )
    .showHelpAfterError()
    .action(
      async (options: {
        message?: string;
        messageFile?: string;
        inputHistoryFile?: string;
        chatHistoryFile?: string;
        multiline?: boolean;
        vim?: boolean;
        editor?: string;
        color?: boolean;
        notifications?: boolean;
        notificationsCommand?: string;
        shellCompletions?: CompletionShell;
      }) => {
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
        await runInput(options, {
          handleMessage: async (message) => {
            const response = await (
              dependencies.handleMessage ?? unavailableProvider
            )(message);
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
            return response;
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
      },
    );
}
