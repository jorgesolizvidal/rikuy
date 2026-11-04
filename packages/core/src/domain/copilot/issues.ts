import type { CopilotIssue, CopilotReviewRow, ProposalField } from "../../contracts/copilot";

/** What each finding of the review says to the staff, in their words. */
export const COPILOT_ISSUE_LABELS: Readonly<Record<CopilotIssue, string>> = {
  never_published: "Nunca se publicó",
  unpublished_changes: "Tiene cambios sin publicar",
  summary_missing: "Sin resumen",
  summary_short: "Resumen muy corto",
  body_missing: "Sin texto",
  body_short: "Texto muy corto",
  cover_missing: "Sin foto de portada",
  location_missing: "Sin ubicación",
  hours_missing: "Sin horario de atención",
  schedule_missing: "Sin fecha",
  tour_missing: "Sin tour 360°",
  scene_description_missing: "Escena sin descripción: la guía del tour no tiene qué contar",
};

/** The texts the Copilot can propose to fix a finding (the rest is the editor's work). */
const FIELDS_FOR: Readonly<Partial<Record<CopilotIssue, readonly ProposalField[]>>> = {
  summary_missing: ["summary"],
  summary_short: ["summary"],
  body_missing: ["body"],
  body_short: ["body"],
  scene_description_missing: ["description"],
};

/** The fields worth proposing for a row of the review (none: nothing the Copilot writes). */
export function proposableFields(row: CopilotReviewRow): ProposalField[] {
  const fields = new Set<ProposalField>();
  for (const issue of row.issues) for (const field of FIELDS_FOR[issue] ?? []) fields.add(field);
  return [...fields];
}

export const PROPOSAL_FIELD_LABELS: Readonly<Record<ProposalField, string>> = {
  title: "Nombre",
  summary: "Resumen",
  body: "Texto",
  description: "Descripción de la escena",
};
