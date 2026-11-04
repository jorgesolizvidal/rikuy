import type { CopilotContentKind, ProposalTarget } from "../../contracts/copilot";

/** Paths of the panel the Copilot links to (one source for pages, answers and tests). */
export const COPILOT_PATHS = {
  home: (org: string) => `/o/${org}/copilot`,
  propose: (org: string, target: ProposalTarget) =>
    target.type === "content"
      ? `/o/${org}/copilot/proponer?contenido=${encodeURIComponent(target.contentId)}`
      : `/o/${org}/copilot/proponer?tour=${encodeURIComponent(target.tourId)}&escena=${encodeURIComponent(target.sceneId)}`,
  proposal: (org: string, id: string) => `/o/${org}/copilot/propuestas/${encodeURIComponent(id)}`,
  editor: (org: string, kind: CopilotContentKind, id: string) =>
    `/o/${org}/${kind === "event" ? "agenda" : "destinos"}/${encodeURIComponent(id)}`,
  tour: (org: string, tourId: string) => `/o/${org}/tours/${encodeURIComponent(tourId)}`,
  knowledge: (org: string, id: string) => `/o/${org}/conocimiento/${encodeURIComponent(id)}`,
  usage: (org: string) => `/o/${org}/uso`,
} as const;

/** The proposal target from the page's query (`?contenido=…` or `?tour=…&escena=…`). */
export function proposalTargetFromQuery(query: {
  readonly contenido?: unknown;
  readonly tour?: unknown;
  readonly escena?: unknown;
}): ProposalTarget | null {
  const uuid = (value: unknown) =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
      ? value.toLowerCase()
      : null;
  const contentId = uuid(query.contenido);
  if (contentId) return { type: "content", contentId };
  const tourId = uuid(query.tour);
  const sceneId = uuid(query.escena);
  return tourId && sceneId ? { type: "scene", tourId, sceneId } : null;
}
