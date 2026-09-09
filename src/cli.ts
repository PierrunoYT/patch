#!/usr/bin/env node

import { createProgram } from "./program.js";
import { isBrokenPipe } from "./io/integrations.js";

process.stdout.on("error", (error) => {
  if (!isBrokenPipe(error)) throw error;
});

await createProgram().parseAsync();
