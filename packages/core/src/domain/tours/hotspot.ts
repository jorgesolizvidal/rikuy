import { DESTINATION_LIMITS, type ImageReference } from "../../contracts/destination";
import { richTextLength, type RichText } from "../../contracts/rich-text";
import {
  HOTSPOT_KINDS,
  TOUR_LIMITS,
  type HotspotChanges,
  type HotspotKind,
  type HotspotPosition,
  type NewHotspot,
} from "../../contracts/tour";
import { parseMarkup } from "../content/markup";
import { normalizeHotspotPosition } from "./scene";

/**
 * Rules for the points of a scene (ADR-029). The panel sends text as typed (the limited
 * Markdown of destinations) and the rules turn it into the stored shape; the database
 * checks it all again. A change carries only the fields the form touched (RC-01).
 */

export type HotspotField = "kind" | "title" | "position" | "body" | "gallery" | "target";
export interface HotspotIssue {
  readonly field: HotspotField;
  readonly code: "required" | "too_long" | "invalid" | "link_not_https" | "alt_required";
  /** 1-based line of the text, for link problems. */
  readonly line?: number;
  /** Index of the photo, for gallery problems. */
  readonly index?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isHotspotKind(value: unknown): value is HotspotKind {
  return typeof value === "string" && (HOTSPOT_KINDS as readonly string[]).includes(value);
}

function title(value: unknown): string | HotspotIssue {
  if (typeof value !== "string") return { field: "title", code: "invalid" };
  const text = value.replace(/\s+/gu, " ").trim();
  if (/\p{Cc}/u.test(text)) return { field: "title", code: "invalid" };
  if (text === "") return { field: "title", code: "required" };
  if (text.length > TOUR_LIMITS.hotspotTitle) return { field: "title", code: "too_long" };
  return text;
}

function position(value: unknown): HotspotPosition | HotspotIssue {
  const raw = value as { yaw?: unknown; pitch?: unknown } | null;
  if (!raw || typeof raw !== "object") return { field: "position", code: "invalid" };
  return (
    normalizeHotspotPosition({ yaw: Number(raw.yaw), pitch: Number(raw.pitch) }) ?? {
      field: "position",
      code: "invalid",
    }
  );
}

/** The text of an information point, written like a destination's (## títulos, - listas…). */
export function parseHotspotBody(value: unknown): RichText | HotspotIssue[] {
  if (typeof value !== "string") return [{ field: "body", code: "invalid" }];
  const parsed = parseMarkup(value);
  if (parsed.problems.length > 0) {
    return parsed.problems.map((problem) => ({
      field: "body" as const,
      code: "link_not_https" as const,
      line: problem.line,
    }));
  }
  if (
    richTextLength(parsed.blocks) > 4000 ||
    new TextEncoder().encode(JSON.stringify(parsed.blocks)).length > TOUR_LIMITS.hotspotBodyBytes
  ) {
    return [{ field: "body", code: "too_long" }];
  }
  return parsed.blocks;
}

function gallery(value: unknown): ImageReference[] | HotspotIssue[] {
  if (!Array.isArray(value) || value.length > TOUR_LIMITS.hotspotPhotos) {
    return [{ field: "gallery", code: "invalid" }];
  }
  const issues: HotspotIssue[] = [];
  const images: ImageReference[] = [];
  value.forEach((entry: unknown, index) => {
    const image = entry as { assetId?: unknown; version?: unknown; alt?: unknown } | null;
    const alt = typeof image?.alt === "string" ? image.alt.replace(/\s+/gu, " ").trim() : "";
    if (
      !image ||
      typeof image.assetId !== "string" ||
      !UUID.test(image.assetId) ||
      typeof image.version !== "number" ||
      !Number.isInteger(image.version) ||
      image.version < 1
    ) {
      issues.push({ field: "gallery", code: "invalid", index });
    } else if (alt === "") {
      issues.push({ field: "gallery", code: "alt_required", index });
    } else if (alt.length > DESTINATION_LIMITS.alt) {
      issues.push({ field: "gallery", code: "too_long", index });
    } else {
      images.push({ assetId: image.assetId, version: image.version, alt });
    }
  });
  return issues.length > 0 ? issues : images;
}

function target(value: unknown): string | HotspotIssue {
  return typeof value === "string" && UUID.test(value)
    ? value
    : { field: "target", code: "required" };
}

const isIssue = (value: unknown): value is HotspotIssue =>
  typeof value === "object" && value !== null && "field" in value && "code" in value;

const TARGET_KEY = {
  scene: "targetSceneId",
  model: "modelVersionId",
  tour: "targetContentId",
} as const;

/** A point the panel wants to add: its kind, title, position and the kind's target. */
export function parseNewHotspot(
  input: Readonly<Record<string, unknown>>,
): { ok: true; hotspot: NewHotspot } | { ok: false; issues: HotspotIssue[] } {
  if (!isHotspotKind(input.kind))
    return { ok: false, issues: [{ field: "kind", code: "invalid" }] };
  const kind = input.kind;
  const issues: HotspotIssue[] = [];
  const parsedTitle = title(input.title);
  const parsedPosition = position(input.position);
  if (isIssue(parsedTitle)) issues.push(parsedTitle);
  if (isIssue(parsedPosition)) issues.push(parsedPosition);

  if (kind === "info") {
    const body = input.body === undefined ? [] : parseHotspotBody(input.body);
    const photos = input.gallery === undefined ? [] : gallery(input.gallery);
    if (body.length > 0 && isIssue(body[0])) issues.push(...(body as HotspotIssue[]));
    if (photos.length > 0 && isIssue(photos[0])) issues.push(...(photos as HotspotIssue[]));
    if (issues.length > 0 || isIssue(parsedTitle) || isIssue(parsedPosition))
      return { ok: false, issues };
    return {
      ok: true,
      hotspot: {
        kind,
        title: parsedTitle,
        position: parsedPosition,
        body: body as RichText,
        gallery: photos as ImageReference[],
      },
    };
  }

  const parsedTarget = target(input[TARGET_KEY[kind]]);
  if (isIssue(parsedTarget)) issues.push(parsedTarget);
  if (
    issues.length > 0 ||
    isIssue(parsedTitle) ||
    isIssue(parsedPosition) ||
    isIssue(parsedTarget)
  ) {
    return { ok: false, issues };
  }
  const base = { title: parsedTitle, position: parsedPosition };
  switch (kind) {
    case "scene":
      return { ok: true, hotspot: { kind, ...base, targetSceneId: parsedTarget } };
    case "model":
      return { ok: true, hotspot: { kind, ...base, modelVersionId: parsedTarget } };
    case "tour":
      return { ok: true, hotspot: { kind, ...base, targetContentId: parsedTarget } };
  }
}

/**
 * Partial changes from a form: only the fields present are validated and returned, and only
 * those that belong to the point's kind. The kind itself never changes.
 */
export function parseHotspotChanges(
  kind: HotspotKind,
  input: Readonly<Record<string, unknown>>,
): { ok: true; changes: HotspotChanges } | { ok: false; issues: HotspotIssue[] } {
  const issues: HotspotIssue[] = [];
  const changes: {
    title?: string;
    position?: HotspotPosition;
    body?: RichText;
    gallery?: ImageReference[];
    targetSceneId?: string;
    modelVersionId?: string;
    targetContentId?: string;
  } = {};
  if ("kind" in input) issues.push({ field: "kind", code: "invalid" });
  if ("title" in input) {
    const value = title(input.title);
    if (isIssue(value)) issues.push(value);
    else changes.title = value;
  }
  if ("position" in input) {
    const value = position(input.position);
    if (isIssue(value)) issues.push(value);
    else changes.position = value;
  }
  if ("body" in input) {
    if (kind !== "info") issues.push({ field: "body", code: "invalid" });
    else {
      const value = parseHotspotBody(input.body);
      if (value.length > 0 && isIssue(value[0])) issues.push(...(value as HotspotIssue[]));
      else changes.body = value as RichText;
    }
  }
  if ("gallery" in input) {
    if (kind !== "info") issues.push({ field: "gallery", code: "invalid" });
    else {
      const value = gallery(input.gallery);
      if (value.length > 0 && isIssue(value[0])) issues.push(...(value as HotspotIssue[]));
      else changes.gallery = value as ImageReference[];
    }
  }
  for (const [key, ownKind] of [
    ["targetSceneId", "scene"],
    ["modelVersionId", "model"],
    ["targetContentId", "tour"],
  ] as const) {
    if (!(key in input)) continue;
    const value = target(input[key]);
    if (kind !== ownKind || isIssue(value)) issues.push({ field: "target", code: "invalid" });
    else changes[key] = value;
  }
  if (issues.length > 0) return { ok: false, issues };
  if (Object.keys(changes).length === 0)
    return { ok: false, issues: [{ field: "title", code: "invalid" }] };
  return { ok: true, changes };
}
