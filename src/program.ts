import { Command } from "commander";

import { runInput, type InputDependencies } from "./input.js";

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
    .showHelpAfterError()
    .action(async (options: { message?: string; messageFile?: string }) => {
      await runInput(options, {
        handleMessage: dependencies.handleMessage ?? unavailableProvider,
        ...(dependencies.lines === undefined
          ? {}
          : { lines: dependencies.lines }),
        ...(dependencies.readMessageFile === undefined
          ? {}
          : { readMessageFile: dependencies.readMessageFile }),
      });
    });
}
