import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["dist/**", "node_modules/**"],
    include: ["tests/**/*.test.ts"],
    // Much of this suite drives real Git subprocesses, temporary worktrees, and
    // loopback HTTP servers. Those tests finish in a few seconds on their own,
    // which left almost no headroom under the default five: the commit-policy
    // lifecycle test runs in about three seconds alone and timed out when the
    // whole suite ran in parallel. The bound is here to catch a hang, not to
    // measure speed.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
