import { base, ignores } from "../../eslint.base.mjs";

export default [
  ignores,
  ...base,
  {
    // Maintenance commands run with Node, outside the app.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
];
