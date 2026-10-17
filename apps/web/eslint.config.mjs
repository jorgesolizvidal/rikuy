import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

import { ignores } from "../../eslint.base.mjs";

const config = [
  ignores,
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Data access goes through use cases (ADR-016): no Supabase SDK in UI code.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@supabase/*"],
              message: "UI must not talk to Supabase directly. Call a use case / server action.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
