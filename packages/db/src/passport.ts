import type {
  CircuitRedeemPin,
  CircuitWriteOutcome,
  CreateCircuitOutcome,
  DeleteCircuitOutcome,
  PassportCircuit,
  PassportRepository,
  PassportRewardRepository,
  PassportStamp,
  PortalCircuit,
  PublishedPassportReader,
  PublishedRewardReader,
  RedeemVoucherOutcome,
  RequestVoucherOutcome,
  SetRedeemPinOutcome,
  PublishedStampReader,
  RenewStampCodeOutcome,
  StampCode,
  StampCodeRepository,
  StampPlace,
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
      // Since 20261120000000 (the web app may be deployed a few minutes before it).
      id: z.uuid().optional(),
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
            id: stop.id ?? null,
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

// ── Stamps (migration 20261120000000, ADR-057) ───────────────────────────────

const stampCodeSchema = z.object({
  contentId: z.uuid(),
  slug: z.string(),
  title: z.string(),
  published: z.boolean(),
  code: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  renewedAt: z.string().nullable(),
  circuits: z.array(z.object({ name: z.string(), status: z.enum(["draft", "published"]) })),
});

/** The stamp codes of the stops, with the signed-in user's session. */
export function createStampCodeRepository(client: SessionClient): StampCodeRepository {
  return {
    async list(tenantId): Promise<StampCode[]> {
      const { data, error } = await client.rpc("tenant_passport_stamp_codes", {
        p_tenant_id: tenantId,
      });
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Listing the stamp codes", error);
      return z.array(stampCodeSchema).parse(data);
    },

    async renew(tenantId, contentId, version): Promise<RenewStampCodeOutcome> {
      const { data, error, status } = await client.rpc("renew_passport_stamp_code", {
        p_tenant_id: tenantId,
        p_content_id: contentId,
        p_version: version,
      });
      if (error) {
        if (error.code === "42501" || status === 403) return { status: "forbidden" };
        if (error.code === "PT409") return { status: "stale" };
        if (error.code === "P0002") return { status: "not_found" };
        throw unexpected("Renewing a stamp code", error);
      }
      return { status: "renewed", version: z.number().int().parse(data) };
    },
  };
}

const stampPlaceSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  cover: publicImageSchema.nullable(),
});

const collectedSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  at: z.number().int(),
  located: z.boolean(),
  signature: z.string(),
});

/** The portal's anonymous stamping (publishable key; the functions check the code). */
export function createSupabasePublishedStampReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedStampReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 3_000;
  return {
    async place(tenantId, code): Promise<StampPlace | null> {
      const { data, error } = await client
        .rpc("portal_stamp_place", { p_tenant_id: tenantId, p_code: code })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (isMissingFunction(error)) return null;
      if (error) throw unexpected("Reading a stamp's place", error);
      if (data === null) return null;
      const place = stampPlaceSchema.parse(data);
      return {
        id: place.id,
        slug: place.slug,
        title: place.title,
        summary: place.summary,
        location:
          place.latitude === null || place.longitude === null
            ? null
            : { lat: place.latitude, lng: place.longitude },
        cover: place.cover,
      };
    },

    async collect(tenantId, code, passportId, located): Promise<PassportStamp | null> {
      const { data, error } = await client
        .rpc("portal_collect_stamp", {
          p_tenant_id: tenantId,
          p_code: code,
          p_passport: passportId,
          p_located: located,
        })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (isMissingFunction(error)) return null;
      if (error) throw unexpected("Collecting a stamp", error);
      if (data === null) return null;
      const stamp = collectedSchema.parse(data);
      return {
        placeId: stamp.id,
        slug: stamp.slug,
        title: stamp.title,
        at: stamp.at,
        located: stamp.located,
        signature: stamp.signature,
      };
    },
  };
}

// ── The prize (migration 20261121000000, ADR-058) ────────────────────────────

/** The shop's key of each circuit, with the signed-in user's session. */
export function createPassportRewardRepository(client: SessionClient): PassportRewardRepository {
  return {
    async pins(tenantId): Promise<CircuitRedeemPin[]> {
      const { data, error } = await client.rpc("tenant_passport_rewards", {
        p_tenant_id: tenantId,
      });
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Reading the shops' keys", error);
      return z
        .array(z.object({ circuitId: z.uuid(), pinSetAt: z.string().nullable() }))
        .parse(data);
    },

    async setPin(tenantId, circuitId, pin): Promise<SetRedeemPinOutcome> {
      const { data, error, status } = await client.rpc("set_passport_redeem_pin", {
        p_tenant_id: tenantId,
        p_circuit_id: circuitId,
        p_pin: pin,
      });
      if (error) {
        if (error.code === "42501" || status === 403) return { status: "forbidden" };
        if (error.code === "P0002") return { status: "not_found" };
        if (error.code === "22023") return { status: "invalid" };
        throw unexpected("Setting a shop's key", error);
      }
      return { status: "saved", pinSetAt: z.string().parse(data) };
    },
  };
}

const voucherSchema = z.object({
  code: z.string(),
  circuit: z.string(),
  circuitName: z.string(),
  reward: z.string(),
  stampsTotal: z.number().int(),
  stampsLocated: z.number().int(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  redeemedAt: z.string().nullable(),
});

const requestSchema = z.discriminatedUnion("status", [
  voucherSchema.extend({ status: z.enum(["issued", "active", "redeemed"]) }),
  z.object({ status: z.literal("incomplete"), missing: z.number().int() }),
  z.object({ status: z.enum(["no_reward", "not_found"]) }),
]);

const redeemSchema = z.discriminatedUnion("status", [
  voucherSchema.extend({ status: z.enum(["valid", "redeemed", "already_redeemed", "expired"]) }),
  z.object({ status: z.literal("no_pin"), circuitName: z.string() }),
  z.object({ status: z.enum(["wrong", "too_many"]) }),
]);

function voucherOf(row: z.infer<typeof voucherSchema>) {
  return {
    code: row.code,
    circuit: row.circuit,
    circuitName: row.circuitName,
    reward: row.reward,
    stampsTotal: row.stampsTotal,
    stampsLocated: row.stampsLocated,
    issuedAt: new Date(row.issuedAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    redeemedAt: row.redeemedAt === null ? null : new Date(row.redeemedAt).toISOString(),
  };
}

/** The portal's anonymous prize: asking for a voucher and redeeming it. */
export function createSupabasePublishedRewardReader(
  options: SupabasePublishedContentReaderOptions,
): PublishedRewardReader {
  const client = createClient(options.url, options.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    async requestVoucher(tenantId, circuit, passportId, stamps): Promise<RequestVoucherOutcome> {
      const { data, error } = await client
        .rpc("portal_request_voucher", {
          p_tenant_id: tenantId,
          p_circuit_slug: circuit,
          p_passport: passportId,
          p_stamps: stamps,
        })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (isMissingFunction(error)) return { status: "not_found" };
      if (error?.code === "22023") return { status: "invalid" };
      if (error) throw unexpected("Asking for a voucher", error);
      const row = requestSchema.parse(data);
      if ("code" in row) return { status: row.status, voucher: voucherOf(row) };
      return row;
    },

    async redeemVoucher(tenantId, code, pin, redeem): Promise<RedeemVoucherOutcome> {
      const { data, error } = await client
        .rpc("portal_redeem_voucher", {
          p_tenant_id: tenantId,
          p_code: code,
          p_pin: pin,
          p_redeem: redeem,
        })
        .abortSignal(AbortSignal.timeout(timeoutMs));
      if (isMissingFunction(error)) return { status: "wrong" };
      if (error) throw unexpected("Redeeming a voucher", error);
      const row = redeemSchema.parse(data);
      if ("code" in row) return { status: row.status, voucher: voucherOf(row) };
      return row;
    },
  };
}
