import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import { ignores } from "../../eslint.base.mjs";

// Data access goes through use cases (ADR-016): no Supabase SDK in UI code.
const noSupabaseInUi = {
  group: ["@supabase/*"],
  message: "UI must not talk to Supabase directly. Call a use case / server action.",
};

// The secret key reaches exactly two isolated modules (CONTRIBUTING §1.3).
const secretKeyModules = ["src/server/identity-admin.ts", "src/server/media-admin.ts"];
const secretKeyPaths = [
  {
    name: "@rikuy/db",
    importNames: ["createSupabaseIdentityAdmin", "createSupabaseMediaAdmin"],
    message: `Adapters with the secret key live only in ${secretKeyModules.join(" and ")}.`,
  },
  {
    name: "@rikuy/config/env",
    importNames: ["parseServerEnv"],
    message: `Server secrets are read only in ${secretKeyModules.join(" and ")}.`,
  },
];

// The workload's database connection (rikuy_worker) is opened in exactly one module.
const jobRunnerModule = "src/server/job-runner.ts";
const jobRunnerPaths = [
  {
    name: "@rikuy/db/worker",
    message: `The job runner's connection lives only in ${jobRunnerModule}.`,
  },
  {
    name: "@rikuy/config/env",
    importNames: ["parseJobRunnerEnv"],
    message: `The job runner's settings are read only in ${jobRunnerModule}.`,
  },
];

const config = [
  ignores,
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [noSupabaseInUi], paths: [...secretKeyPaths, ...jobRunnerPaths] },
      ],
    },
  },
  {
    // Next renders a Server Action redirect with an internal fetch to its own origin
    // (e.g. http://localhost:3000), bypassing host-based tenant resolution. Actions return
    // state and the client navigates instead.
    files: ["src/**/actions.ts", "src/**/*.action.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [noSupabaseInUi],
          paths: [
            ...secretKeyPaths,
            ...jobRunnerPaths,
            {
              name: "next/navigation",
              importNames: ["redirect", "permanentRedirect"],
              message:
                "No redirects inside Server Actions: they skip host resolution. Return state and navigate on the client.",
            },
          ],
        },
      ],
    },
  },
  {
    files: secretKeyModules,
    rules: {
      "no-restricted-imports": ["error", { patterns: [noSupabaseInUi], paths: jobRunnerPaths }],
    },
  },
  {
    files: [jobRunnerModule],
    rules: {
      "no-restricted-imports": ["error", { patterns: [noSupabaseInUi], paths: secretKeyPaths }],
    },
  },
];

export default config;
