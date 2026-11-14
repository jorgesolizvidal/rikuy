import { isModuleKey, type ModuleKey } from "@rikuy/core";

/**
 * The modules a row lists (ADR-060). A key this app does not know yet (a module added to the
 * catalog after this version was deployed) is left out instead of failing the whole read.
 * No column at all (a database before that migration) gives `undefined`: everything.
 */
export function moduleKeysOf(value: unknown): ModuleKey[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isModuleKey);
}
