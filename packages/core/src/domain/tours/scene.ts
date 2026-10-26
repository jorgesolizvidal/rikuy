import {
  TOUR_LIMITS,
  type SceneChanges,
  type SceneView,
  type TourRevision,
} from "../../contracts/tour";

/**
 * Rules for scenes and their views, shared by the panel and the database (which checks
 * them again): titles are trimmed single lines, views are normalized angles.
 */

const TWO_PI = 2 * Math.PI;

/** Any yaw → [-π, π). */
export function normalizeYaw(yaw: number): number {
  const turned = (((yaw + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI;
  const result = turned - Math.PI;
  return result >= Math.PI ? -Math.PI : result;
}

/** A view as a viewer reports it → a valid stored view (rounded to ~0.001 rad / 0.1°). */
export function normalizeSceneView(view: {
  readonly yaw: number;
  readonly pitch: number;
  readonly fov: number;
}): SceneView | null {
  if (![view.yaw, view.pitch, view.fov].every(Number.isFinite)) return null;
  // Rounded to `digits` decimals, and still inside [min, max] after rounding (π itself is
  // not a 3-decimal number: 3.142 > π would be refused).
  const fit = (value: number, min: number, max: number, digits: number) => {
    const scale = 10 ** digits;
    const low = Math.ceil(min * scale) / scale;
    const high = Math.floor(max * scale) / scale;
    return Math.min(high, Math.max(low, Math.round(value * scale) / scale));
  };
  const halfPi = Math.PI / 2;
  return {
    yaw: fit(normalizeYaw(view.yaw), -Math.PI, Math.PI, 3),
    pitch: fit(view.pitch, -halfPi, halfPi, 3),
    fov: fit(view.fov, TOUR_LIMITS.fov.min, TOUR_LIMITS.fov.max, 1),
  };
}

export type SceneField = "title" | "description" | "initialView";
export type SceneIssue = {
  readonly field: SceneField;
  readonly code: "required" | "too_long" | "invalid";
};

function line(
  value: unknown,
  max: number,
  required: boolean,
): string | "required" | "too_long" | "invalid" {
  if (typeof value !== "string") return "invalid";
  const text = value.replace(/\s+/gu, " ").trim();
  if (/\p{Cc}/u.test(text)) return "invalid";
  if (required && text === "") return "required";
  if (text.length > max) return "too_long";
  return text;
}

/** A scene title as typed → the stored title, or the problem. */
export function parseSceneTitle(value: unknown): { title: string } | { issue: SceneIssue } {
  const result = line(value, TOUR_LIMITS.sceneTitle, true);
  if (result === "required" || result === "too_long" || result === "invalid") {
    return { issue: { field: "title", code: result } };
  }
  return { title: result };
}

/**
 * Validates partial changes from a form: only the fields present are checked and sent.
 * Descriptions keep their line breaks out (one paragraph, like a summary).
 */
export function parseSceneChanges(
  input: Readonly<Record<string, unknown>>,
): { ok: true; changes: SceneChanges } | { ok: false; issues: SceneIssue[] } {
  const issues: SceneIssue[] = [];
  const changes: { title?: string; description?: string; initialView?: SceneView } = {};
  if ("title" in input) {
    const parsed = parseSceneTitle(input.title);
    if ("issue" in parsed) issues.push(parsed.issue);
    else changes.title = parsed.title;
  }
  if ("description" in input) {
    const result = line(input.description, TOUR_LIMITS.sceneDescription, false);
    if (result === "too_long" || result === "invalid" || result === "required") {
      issues.push({ field: "description", code: result });
    } else changes.description = result;
  }
  if ("initialView" in input) {
    const raw = input.initialView as { yaw?: unknown; pitch?: unknown; fov?: unknown } | null;
    const view =
      raw && typeof raw === "object"
        ? normalizeSceneView({
            yaw: Number(raw.yaw),
            pitch: Number(raw.pitch),
            fov: Number(raw.fov),
          })
        : null;
    if (view === null) issues.push({ field: "initialView", code: "invalid" });
    else changes.initialView = view;
  }
  if (issues.length > 0) return { ok: false, issues };
  if (Object.keys(changes).length === 0)
    return { ok: false, issues: [{ field: "title", code: "invalid" }] };
  return { ok: true, changes };
}

export type TourPublicationIssue = "no_scenes" | "no_entry" | "panorama_missing";

/** What keeps a revision from being published (the database checks it again). */
export function tourPublicationIssues(revision: TourRevision): TourPublicationIssue[] {
  if (revision.scenes.length === 0) return ["no_scenes"];
  const issues: TourPublicationIssue[] = [];
  if (!revision.scenes.some((scene) => scene.sceneId === revision.entrySceneId))
    issues.push("no_entry");
  if (revision.scenes.some((scene) => scene.panorama.manifest === null))
    issues.push("panorama_missing");
  return issues;
}
