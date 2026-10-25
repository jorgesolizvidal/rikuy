import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/** Browser checks that need Chrome but no app server (CI job "Contracts"). */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
