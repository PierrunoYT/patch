#!/usr/bin/env node

import { createProgram } from "./program.js";
import { isBrokenPipe } from "./io/integrations.js";
import { sanitizeTerminalText } from "./io/sanitize.js";

process.stdout.on("error", (error) => {
  if (!isBrokenPipe(error)) throw error;
});

try {
  await createProgram().parseAsync();
} catch (error) {
  // A failure message can quote a path, a command, or child output, so it is
  // sanitized like every other untrusted string that reaches the terminal.
  process.stderr.write(
    `${sanitizeTerminalText(error instanceof Error ? error.message : String(error))}\n`,
  );
  process.exitCode = 1;
}
