import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";

describe("CLI", () => {
  it("identifies the executable and its purpose in help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: patch [options]");
    expect(help).toContain("AI pair programming in your terminal");
    expect(help).toContain("--help");
  });
});
