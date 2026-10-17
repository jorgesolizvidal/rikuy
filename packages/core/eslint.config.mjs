import { base, frameworkFreeRestriction, ignores } from "../../eslint.base.mjs";

// core = domain + application + contracts. It must stay framework-free.
export default [ignores, ...base, frameworkFreeRestriction];
