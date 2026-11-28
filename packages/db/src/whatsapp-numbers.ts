import type {
  PlatformWhatsAppRepository,
  WhatsAppNumber,
  WhatsAppNumberRepository,
  WhatsAppNumbersOutcome,
} from "@rikuy/core";
import type { PostgrestError } from "@supabase/supabase-js";
import { z } from "zod";

import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

/**
 * The WhatsApp numbers of a municipality's assistant (migration 20261206000000, ADR-075).
 * The web app can be deployed a few minutes before the migration: until then there are none.
 */

function unexpected(operation: string, error: PostgrestError): Error {
  return new Error(`${operation} failed (${error.code || "unknown"})`);
}

const numbersSchema = z.array(
  z.object({
    phoneNumberId: z.string(),
    displayPhone: z.string().nullable(),
    createdAt: z.string(),
  }),
);

function parseNumbers(data: unknown): WhatsAppNumber[] {
  return numbersSchema.parse(data ?? []);
}

function outcome(
  data: unknown,
  error: PostgrestError | null,
  operation: string,
): WhatsAppNumbersOutcome {
  if (!error) return { status: "updated", numbers: parseNumbers(data) };
  if (error.code === "42501") return { status: "forbidden" };
  if (error.code === "PT404") return { status: "not_found" };
  if (error.code === "PT409") return { status: error.hint === "taken" ? "taken" : "too_many" };
  if (error.code === "23514" || error.code === "22P02" || error.code === "22023") {
    return { status: error.hint === "display_phone" ? "display" : "invalid" };
  }
  if (isMissingFunction(error)) return { status: "error" };
  throw unexpected(operation, error);
}

/** The operator's side (second factor). */
export function createPlatformWhatsAppRepository(
  client: SessionClient,
): PlatformWhatsAppRepository {
  return {
    async list(tenantId) {
      const { data, error } = await client.rpc("platform_whatsapp_numbers", {
        p_tenant_id: tenantId,
      });
      if (isMissingFunction(error)) return [];
      if (error?.code === "42501") return null;
      if (error) throw unexpected("Listing the WhatsApp numbers", error);
      return parseNumbers(data);
    },

    async add(tenantId, phoneNumberId, displayPhone) {
      const { data, error } = await client.rpc("platform_add_whatsapp_number", {
        p_tenant_id: tenantId,
        p_phone_number_id: phoneNumberId,
        p_display_phone: displayPhone,
      });
      return outcome(data, error, "Adding a WhatsApp number");
    },

    async remove(tenantId, phoneNumberId) {
      const { data, error } = await client.rpc("platform_remove_whatsapp_number", {
        p_tenant_id: tenantId,
        p_phone_number_id: phoneNumberId,
      });
      return outcome(data, error, "Removing a WhatsApp number");
    },
  };
}

/** A member's side: the municipality's numbers. */
export function createWhatsAppNumberRepository(client: SessionClient): WhatsAppNumberRepository {
  return {
    async numbers(tenantId) {
      const { data, error } = await client.rpc("tenant_whatsapp_numbers", {
        p_tenant_id: tenantId,
      });
      if (isMissingFunction(error)) return [];
      if (error) throw unexpected("Reading the WhatsApp numbers", error);
      return parseNumbers(data);
    },
  };
}
