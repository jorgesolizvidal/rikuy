// Shared ESLint flat config for every workspace package.
// Packages import this and add their own layer restrictions.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export const ignores = {
  ignores: [
    "**/node_modules/**",
    "**/.next/**",
    "**/dist/**",
    "**/coverage/**",
    "**/*.d.ts",
    "**/public/vendor/**",
  ],
};

export const base = tseslint.config(js.configs.recommended, ...tseslint.configs.strict, {
  rules: {
    "@typescript-eslint/consistent-type-imports": "error",
    "@typescript-eslint/no-unused-vars": [
      "error",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
    ],
    "no-console": ["warn", { allow: ["warn", "error", "info"] }],
  },
});

/**
 * Imports that must never appear in framework-agnostic code (domain/application).
 * Keeps business rules independent from Next.js, React, Supabase, AI providers and job runtimes.
 */
export const frameworkFreeRestriction = {
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          { group: ["next", "next/*"], message: "core must not depend on Next.js." },
          { group: ["react", "react-dom", "react/*"], message: "core must not depend on React." },
          { group: ["@supabase/*"], message: "Use a repository port; adapters live in @rikuy/db." },
          { group: ["@rikuy/db", "@rikuy/ui"], message: "core is the innermost layer." },
          {
            group: ["groq-sdk", "openai", "@google/*"],
            message: "AI providers go behind the AI gateway port.",
          },
          {
            group: ["@trigger.dev/*", "workflow", "workflow/*"],
            message: "Job runtimes go behind a port.",
          },
        ],
      },
    ],
  },
};
