import type { CopilotReviewRow, CopilotSnapshotRow } from "../../contracts/copilot";
import { hasModule, type ModuleKey } from "../../domain/tenancy/modules";
import type { CopilotRepository } from "./ports";

/**
 * What the Copilot reviews and reads when some modules are off (ADR-060): no events
 * without the agenda, and nothing about tours without the tours. The content is kept; it
 * only stops being asked for.
 */
export function reviewForModules(
  rows: readonly CopilotReviewRow[],
  modules: readonly ModuleKey[] | undefined,
): CopilotReviewRow[] {
  const agenda = hasModule(modules, "agenda");
  const tours = hasModule(modules, "tours");
  return rows.flatMap((row) => {
    if (row.kind === "event" && !agenda) return [];
    if (tours) return [row];
    if (row.sceneId !== null) return [];
    const issues = row.issues.filter(
      (issue) => issue !== "tour_missing" && issue !== "scene_description_missing",
    );
    return issues.length > 0 ? [{ ...row, issues }] : [];
  });
}

export function snapshotForModules(
  rows: readonly CopilotSnapshotRow[],
  modules: readonly ModuleKey[] | undefined,
): CopilotSnapshotRow[] {
  const agenda = hasModule(modules, "agenda");
  const tours = hasModule(modules, "tours");
  return rows.flatMap((row) => {
    if (row.kind === "event" && !agenda) return [];
    return [tours || row.tour === null ? row : { ...row, tour: null }];
  });
}

/** The same repository, reading through those filters. */
export function copilotForModules(
  copilot: CopilotRepository,
  modules: readonly ModuleKey[] | undefined,
): CopilotRepository {
  if (modules === undefined) return copilot;
  return {
    ...copilot,
    review: async (tenantId) => reviewForModules(await copilot.review(tenantId), modules),
    snapshot: async (tenantId) => {
      const data = await copilot.snapshot(tenantId);
      return { ...data, items: snapshotForModules(data.items, modules) };
    },
  };
}
