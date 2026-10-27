import { z } from "zod";

import type { OrganizationMembership } from "../../contracts/organization";
import { tourContentKindSchema } from "../../contracts/tour";
import { canPublishContent } from "../content/editing";

/**
 * The general tour (P4 · Paso 5, ADR-032): every visible tour of the municipality, in the
 * order it chooses, starting where it chooses. Nothing to publish: the order applies at
 * once, so only owners and administrators change it (like publishing).
 */
export const GENERAL_TOUR_LIMIT = 200;

export const generalTourDocumentSchema = z.object({
  editCount: z.number().int().min(0),
  startTourId: z.uuid().nullable(),
  tours: z.array(
    z.object({
      tourId: z.uuid(),
      kind: tourContentKindSchema,
      slug: z.string(),
      /** null: the destination or event was never published. */
      title: z.string().nullable(),
      position: z.number().int().nullable(),
      contentPublished: z.boolean(),
      ended: z.boolean(),
      /** Visitors see it now (published content and tour, not an ended event). */
      visible: z.boolean(),
    }),
  ),
});

export type GeneralTourDocument = z.infer<typeof generalTourDocumentSchema>;
export type GeneralTourEntry = GeneralTourDocument["tours"][number];

export type SaveGeneralTourOutcome =
  | { readonly status: "saved"; readonly editCount: number }
  | { readonly status: "conflict" | "forbidden" }
  | { readonly status: "invalid"; readonly reason: "order" | "start" };

export interface GeneralTourRepository {
  load(tenantId: string): Promise<GeneralTourDocument>;
  save(
    tenantId: string,
    expectedEdit: number,
    order: readonly string[],
    startTourId: string | null,
  ): Promise<SaveGeneralTourOutcome>;
}

export interface GeneralTourView {
  readonly document: GeneralTourDocument;
  readonly canEdit: boolean;
}

export async function loadGeneralTour(
  membership: OrganizationMembership,
  deps: { readonly general: Pick<GeneralTourRepository, "load"> },
): Promise<GeneralTourView> {
  return {
    document: await deps.general.load(membership.tenantId),
    canEdit: canPublishContent(membership.role),
  };
}

const saveInputSchema = z.object({
  expectedEdit: z.number().int().min(0),
  order: z
    .array(z.uuid())
    .max(GENERAL_TOUR_LIMIT)
    .refine((ids) => new Set(ids).size === ids.length),
  startTourId: z.uuid().nullable(),
});

export async function saveGeneralTour(
  membership: OrganizationMembership,
  input: unknown,
  deps: { readonly general: Pick<GeneralTourRepository, "save"> },
): Promise<SaveGeneralTourOutcome> {
  if (!canPublishContent(membership.role)) return { status: "forbidden" };
  const parsed = saveInputSchema.safeParse(input);
  if (!parsed.success) {
    const start = parsed.error.issues.some((issue) => issue.path[0] === "startTourId");
    return { status: "invalid", reason: start ? "start" : "order" };
  }
  const { expectedEdit, order, startTourId } = parsed.data;
  return deps.general.save(membership.tenantId, expectedEdit, order, startTourId);
}
