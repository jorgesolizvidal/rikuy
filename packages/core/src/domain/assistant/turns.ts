import type { AssistantActionKey } from "./statistics";

/**
 * Each answer of the visitor's assistant as the database keeps it (ADR-074): its channel, its
 * kind and what it cited; and what the visitor tapped in it afterwards.
 */

export type AssistantTurnKind = "answered" | "abstained" | "plan" | "notice";

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const PLACE = new RegExp(`^/(destinos|agenda)/(${SLUG})$`, "u");
const TOUR = new RegExp(`^/(destinos|agenda)/(${SLUG})/tour$`, "u");
const ANCHORED = new RegExp(`^/(avisos|servicios|memoria|preguntas-frecuentes)$`, "u");
const ANCHOR_KIND: Readonly<Record<string, string>> = {
  avisos: "notice",
  servicios: "service",
  memoria: "story",
  "preguntas-frecuentes": "faq",
};
const KEY = new RegExp(`^${SLUG}$`, "u");

/** What a link inside an answer leads to, from its portal path; null when it is not one. */
export function assistantActionOf(
  path: string,
): { readonly action: AssistantActionKey; readonly key: string | null } | null {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 300) return null;
  let url: URL;
  try {
    url = new URL(path, "https://portal.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://portal.invalid") return null;
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  const tour = TOUR.exec(pathname);
  if (tour?.[1] && tour[2]) {
    return {
      action: "tour",
      key: `${tour[1] === "destinos" ? "destination" : "event"}_tour:${tour[2]}`,
    };
  }
  if (pathname === "/recorrido") return { action: "tour", key: null };
  if (pathname === "/mapa") return { action: "map", key: null };
  const place = PLACE.exec(pathname);
  if (place?.[1] && place[2]) {
    return {
      action: "place",
      key: `${place[1] === "destinos" ? "destination" : "event"}:${place[2]}`,
    };
  }
  const anchored = ANCHORED.exec(pathname);
  const anchor = url.hash.slice(1);
  if (anchored?.[1] && KEY.test(anchor)) {
    return { action: "place", key: `${ANCHOR_KIND[anchored[1]]}:${anchor}` };
  }
  return { action: "section", key: null };
}

/** A link tapped in an answer, as the browser reports it. */
export interface AssistantActionReport {
  readonly requestId: string;
  readonly action: AssistantActionKey;
  readonly key: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** `{ ref, path }` from a link, or `{ ref, action: "person" }`; null when it is neither. */
export function parseAssistantAction(raw: unknown): AssistantActionReport | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { ref, path, action } = raw as Record<string, unknown>;
  if (typeof ref !== "string" || !UUID.test(ref)) return null;
  if (action === "person") return { requestId: ref, action: "person", key: null };
  if (typeof path !== "string") return null;
  const found = assistantActionOf(path);
  return found ? { requestId: ref, ...found } : null;
}
