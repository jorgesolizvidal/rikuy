import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import { ignores } from "../../eslint.base.mjs";

// Data access goes through use cases (ADR-016): no Supabase SDK in UI code.
const noSupabaseInUi = {
  group: ["@supabase/*"],
  message: "UI must not talk to Supabase directly. Call a use case / server action.",
};

// The secret key reaches exactly one module (CONTRIBUTING §1.3).
const secretKeyPaths = [
  {
    name: "@rikuy/db",
    importNames: ["createSupabaseIdentityAdmin"],
    message: "Identity administration (secret key) lives only in src/server/identity-admin.ts.",
  },
  {
    name: "@rikuy/config/env",
    importNames: ["parseServerEnv"],
    message: "Server secrets are read only in src/server/identity-admin.ts.",
  },
];

const config = [
  ignores,
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-imports": ["error", { patterns: [noSupabaseInUi], paths: secretKeyPaths }],
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
    files: ["src/server/identity-admin.ts"],
    rules: { "no-restricted-imports": ["error", { patterns: [noSupabaseInUi] }] },
  },
];

export default config;
