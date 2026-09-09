import { Command } from "commander";

export function createProgram(): Command {
  return new Command()
    .name("patch")
    .description("AI pair programming in your terminal")
    .showHelpAfterError();
}
