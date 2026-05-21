import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Integration tests share one test DB — force serial execution.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
    hookTimeout: 60_000,
  },
});
