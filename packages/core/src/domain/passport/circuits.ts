/**
 * The circuits of the tourist passport (C2 · Paso 1, ADR-056): a name, a short description,
 * the prize for completing it (in words) and its stops — published destinations of the
 * municipality, in a suggested order; the visitor may collect them in any order.
 */

export const CIRCUIT_LIMITS = {
  slug: 80,
  name: 80,
  summary: 300,
  reward: 200,
  stops: 30,
  /** Stops with a published destination a circuit needs to be published. */
  minPublishedStops: 2,
} as const;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// Line breaks and other control characters: every field is a single line.
const CONTROL = /\p{Cc}/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface CircuitDraft {
  readonly name: string;
  readonly summary: string;
  readonly reward: string;
  /** Destination content ids, in the suggested order. */
  readonly stops: readonly string[];
}

export type CircuitField = "name" | "summary" | "reward" | "stops";

export type CircuitDraftResult =
  | { readonly ok: true; readonly value: CircuitDraft }
  | { readonly ok: false; readonly errors: Partial<Record<CircuitField, string>> };

export function isCircuitSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= CIRCUIT_LIMITS.slug && SLUG.test(value);
}

function line(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return CONTROL.test(value) ? null : value.trim();
}

/** Checks a circuit the way the database does, with messages for the form. */
export function parseCircuitDraft(input: {
  readonly name: unknown;
  readonly summary: unknown;
  readonly reward: unknown;
  readonly stops: unknown;
}): CircuitDraftResult {
  const errors: Partial<Record<CircuitField, string>> = {};
  const name = line(input.name);
  if (name === null || name.length === 0) errors.name = "Escribe el nombre del circuito.";
  else if (name.length > CIRCUIT_LIMITS.name)
    errors.name = `El nombre puede tener hasta ${CIRCUIT_LIMITS.name} caracteres.`;
  const summary = line(input.summary ?? "");
  if (summary === null) errors.summary = "La descripción va en una sola línea.";
  else if (summary.length > CIRCUIT_LIMITS.summary)
    errors.summary = `La descripción puede tener hasta ${CIRCUIT_LIMITS.summary} caracteres.`;
  const reward = line(input.reward ?? "");
  if (reward === null) errors.reward = "El premio va en una sola línea.";
  else if (reward.length > CIRCUIT_LIMITS.reward)
    errors.reward = `El premio puede tener hasta ${CIRCUIT_LIMITS.reward} caracteres.`;
  const stops = Array.isArray(input.stops) ? input.stops : null;
  if (
    stops === null ||
    !stops.every((stop): stop is string => typeof stop === "string" && UUID.test(stop))
  ) {
    errors.stops = "Las paradas no son válidas.";
  } else if (new Set(stops).size !== stops.length) {
    errors.stops = "Un destino está dos veces en el circuito.";
  } else if (stops.length > CIRCUIT_LIMITS.stops) {
    errors.stops = `Un circuito puede tener hasta ${CIRCUIT_LIMITS.stops} paradas.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name: name ?? "",
      summary: summary ?? "",
      reward: reward ?? "",
      stops: (stops ?? []) as string[],
    },
  };
}

/** What keeps a circuit from being published, in words (empty: it can be published). */
export function circuitPublishIssues(circuit: {
  readonly stops: readonly { readonly published: boolean }[];
}): string[] {
  const published = circuit.stops.filter((stop) => stop.published).length;
  const issues: string[] = [];
  if (published < CIRCUIT_LIMITS.minPublishedStops) {
    issues.push(
      published === 0
        ? "Agrega al menos dos destinos publicados."
        : "Agrega al menos un destino publicado más (hacen falta dos).",
    );
  }
  return issues;
}
