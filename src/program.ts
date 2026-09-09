import { Command } from "commander";

import { runInput, type InputDependencies } from "./input.js";
import { TerminalHistory } from "./io/history.js";

export type ProgramDependencies = Partial<InputDependencies>;

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
    .showHelpAfterError()
    .action(
      async (options: {
        message?: string;
        messageFile?: string;
        inputHistoryFile?: string;
        chatHistoryFile?: string;
      }) => {
        const history = new TerminalHistory({
          ...(options.inputHistoryFile === undefined
            ? {}
            : { input: options.inputHistoryFile }),
          ...(options.chatHistoryFile === undefined
            ? {}
            : { chat: options.chatHistoryFile }),
        });
        await runInput(options, {
          handleMessage: dependencies.handleMessage ?? unavailableProvider,
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
