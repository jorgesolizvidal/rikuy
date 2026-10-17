import { defineConfig } from "vitest/config";

/** Runs against a real local Supabase stack (CI job "Auth integration"). */
export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
