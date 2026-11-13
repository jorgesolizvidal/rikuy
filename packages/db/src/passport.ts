import type {
  CircuitWriteOutcome,
  CreateCircuitOutcome,
  DeleteCircuitOutcome,
  PassportCircuit,
  PassportRepository,
  PortalCircuit,
  PublishedPassportReader,
} from "@rikuy/core";
import { createClient, type PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import {
  publicImageSchema,
  unexpected,
  type SupabasePublishedContentReaderOptions,
} from "./content";
import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

/**
 * The tourist passport's circuits (migration 20261119000000, ADR-056): the panel's
 * repository with the signed-in user's session and the portal's anonymous reader.
 */

const circuitSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  reward: z.string(),
  status: z.enum(["draft", "published"]),
  editNo: z.number().int(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string(),
  stops: z.array(
    z.object({
      contentId: z.uuid(),
      position: z.number().int(),
      slug: z.string(),
      title: z.string(),
      published: z.boolean(),
    }),
  ),
});

function hint(error: PostgrestError): string {
  return error.hint ?? "";
}

function writeFailure(
  error: PostgrestError,
  status: number,
  operation: string,
): CircuitWriteOutcome {
  if (error.code === "42501" || status === 403) return { status: "forbidden" };
  if (error.code === "PT409") return { status: "stale" };
  if (error.code === "P0002") return { status: "not_found" };
  if (error.code === "23514" && hint(error) === "incomplete") return { status: "incomplete" };
  if (error.code === "22023" || error.code === "23514") return { status: "invalid" };
  throw unexpected(operation, error);
}

export function createPassportRepository(client: SessionClient): PassportRepository {
  const write = async (
    fn: string,
    args: Record<string, unknown>,
    operation: string,
  ): Promise<CircuitWriteOutcome> => {
    const { data, error, status } = await client.rpc(fn, args);
    if (error) return writeFailure(error, status, operation);
    return { status: "saved", editNo: z.number().int().parse(data) };
  };

  return {
    async list(tenantId): Promise<PassportCircuit[]> {
      const { data, error } = await client.rpc("tenant_passport_circuits", {
        p_tenant_id: tenantId,
      });
      // The web app may be deployed a few minutes before the migration.
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Listing the passport circuits", error);
      return z.array(circuitSchema).parse(data);
    },

    async create(tenantId, slug, name): Promise<CreateCircuitOutcome> {
      const { data, error, status } = await client.rpc("create_passport_circuit", {
        p_tenant_id: tenantId,
        p_slug: slug,
        p_name: name,
      });
      if (error) {
        if (error.code === "42501" || status === 403) return { status: "forbidden" };
        if (error.code === "23505") return { status: "taken" };
        if (error.code === "22023") return { status: "invalid" };
        throw unexpected("Creating a passport circuit", error);
      }
      return { status: "created", circuitId: z.uuid().parse(data) };
    },

    save: (tenantId, circuitId, editNo, draft) =>
      write(
        "save_passport_circuit",
        {
          p_tenant_id: tenantId,
          p_circuit_id: circuitId,
          p_edit_no: editNo,
          p_name: draft.name,
          p_summary: draft.summary,
          p_reward: draft.reward,
          p_stops: draft.stops,
        },
        "Saving a passport circuit",
      ),

    publish: (tenantId, circuitId, editNo) =>
      write(
        "publish_passport_circuit",
        { p_tenant_id: tenantId, p_circuit_id: circuitId, p_edit_no: editNo },
        "Publishing a passport circuit",
      ),

    withdraw: (tenantId, circuitId, editNo) =>
      write(
        "withdraw_passport_circuit",
        { p_tenant_id: tenantId, p_circuit_id: circuitId, p_edit_no: editNo },
        "Withdrawing a passport circuit",
      ),

    async remove(tenantId, circuitId, editNo): Promise<DeleteCircuitOutcome> {
      const { error, status } = await client.rpc("delete_passport_circuit", {
        p_tenant_id: tenantId,
        p_circuit_id: circuitId,
        p_edit_no: editNo,
      });
      if (!error) return { status: "deleted" };
      if (error.code === "42501" || status === 403) return { status: "forbidden" };
      if (error.code === "PT409") return { status: "stale" };
      if (error.code === "P0002") return { status: "not_found" };
      if (error.code === "23514" && hint(error) === "published") return { status: "published" };
      throw unexpected("Deleting a passport circuit", error);
    },
  };
}

const portalCircuitSchema = z.object({
  slug: z.string(),
  name: z.string(),
  summary: z.string(),
  reward: z.string(),
  publishedAt: z.string().transform((value) => new Date(value).toISOString()),
  stops: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      summary: z.string(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      cover: publicImageSchema.nullable(),
    }),
  ),
});

/** The portal's anonymous reader (publishable key; the function checks what is public). */
export function createSupabasePublishedPassportReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedPassportReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async circuits(tenantId): Promise<PortalCircuit[]> {
      const { data, error } = await client
        .rpc("portal_passport", { p_tenant_id: tenantId })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Listing the passport circuits", error);
      return z
        .array(portalCircuitSchema)
        .parse(data)
        .map((circuit) => ({
          ...circuit,
          stops: circuit.stops.map((stop) => ({
            slug: stop.slug,
            title: stop.title,
            summary: stop.summary,
            location:
              stop.latitude === null || stop.longitude === null
                ? null
                : { lat: stop.latitude, lng: stop.longitude },
            cover: stop.cover,
          })),
        }));
    },
  };
}
