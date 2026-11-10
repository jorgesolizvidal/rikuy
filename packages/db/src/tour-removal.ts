import { createClient, type PostgrestError } from "@supabase/supabase-js";
import type {
  DeleteTourOutcome,
  MoveTourOutcome,
  PublishedTourRedirectReader,
  TourRemovalRepository,
} from "@rikuy/core";
import { z } from "zod";

import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

/**
 * Deleting and moving tours (migration 20261113000000, ADR-049) with the signed-in user's
 * session: the RPCs re-check role and tenant. Database codes become outcomes. Before the
 * migration (the web ships minutes earlier) the panel shows nothing to do and the portal
 * redirects nothing.
 */

const kind = z.enum(["destination", "event"]);
const placesSchema = z.array(z.object({ kind, slug: z.string() }));

const impactSchema = z.tuple([
  z.object({
    content_id: z.uuid(),
    revisions: z.number().int(),
    published: z.boolean(),
    in_general_tour: z.boolean(),
    starts_general_tour: z.boolean(),
    linked_from: z.array(
      z.object({
        tourId: z.uuid(),
        contentKind: kind,
        contentTitle: z.string(),
        draft: z.boolean(),
        published: z.boolean(),
      }),
    ),
  }),
]);

function unexpected(operation: string, error: PostgrestError): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

export function createTourRemovalRepository(client: SessionClient): TourRemovalRepository {
  return {
    async removalImpact(tenantId, tourId) {
      const { data, error } = await client.rpc("tour_removal_impact", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
      });
      if (error) {
        if (error.code === "PT404" || error.code === "42501" || isMissingFunction(error)) {
          return null;
        }
        throw unexpected("Reading what removing a tour changes", error);
      }
      const [row] = impactSchema.parse(data);
      return {
        contentId: row.content_id,
        revisions: row.revisions,
        published: row.published,
        inGeneralTour: row.in_general_tour,
        startsGeneralTour: row.starts_general_tour,
        linkedFrom: row.linked_from,
      };
    },

    async deleteTour(tenantId, tourId): Promise<DeleteTourOutcome> {
      const { data, error } = await client.rpc("delete_tour", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
      });
      if (error) {
        if (error.code === "42501") return { status: "forbidden" };
        if (error.code === "PT404") return { status: "not_found" };
        throw unexpected("Deleting a tour", error);
      }
      const [row] = z
        .tuple([
          z.object({ content_kind: kind, content_slug: z.string(), former_places: placesSchema }),
        ])
        .parse(data);
      return {
        status: "deleted",
        place: { kind: row.content_kind, slug: row.content_slug },
        formerPlaces: row.former_places,
      };
    },

    async moveTour(tenantId, tourId, contentId): Promise<MoveTourOutcome> {
      const { data, error } = await client.rpc("move_tour", {
        p_tenant_id: tenantId,
        p_tour_id: tourId,
        p_content_id: contentId,
      });
      if (error) {
        if (error.code === "42501") return { status: "forbidden" };
        if (error.code === "PT404" || error.code === "23514") return { status: "not_found" };
        if (error.code === "PT409") {
          if (error.hint === "same" || error.hint === "taken" || error.hint === "self_link") {
            return { status: error.hint };
          }
        }
        throw unexpected("Moving a tour", error);
      }
      const [row] = z
        .tuple([
          z.object({
            from_kind: kind,
            from_slug: z.string(),
            to_kind: kind,
            to_slug: z.string(),
            former_places: placesSchema,
          }),
        ])
        .parse(data);
      return {
        status: "moved",
        from: { kind: row.from_kind, slug: row.from_slug },
        to: { kind: row.to_kind, slug: row.to_slug },
        formerPlaces: row.former_places,
      };
    },
  };
}

export interface SupabasePublishedTourRedirectReaderOptions {
  readonly url: string;
  readonly publishableKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** Anonymous: where a tour page that is not found leads (the portal caches the answer). */
export function createSupabasePublishedTourRedirectReader(
  options: SupabasePublishedTourRedirectReaderOptions,
): PublishedTourRedirectReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async find(tenantId, contentKind, slug) {
      const { data, error } = await client
        .rpc("portal_tour_redirect", { p_tenant_id: tenantId, p_kind: contentKind, p_slug: slug })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (error) {
        if (isMissingFunction(error)) return null;
        throw unexpected("Reading where a tour went", error);
      }
      const [row] = z
        .array(z.object({ kind, slug: z.string(), target: z.enum(["tour", "place"]) }))
        .max(1)
        .parse(data);
      return row ? { kind: row.kind, slug: row.slug, target: row.target } : null;
    },
  };
}
