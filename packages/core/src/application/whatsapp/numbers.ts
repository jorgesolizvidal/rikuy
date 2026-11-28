/**
 * The WhatsApp numbers of a municipality's assistant (A · Paso 6, ADR-075). Only the platform
 * operator registers or removes one (the database checks it again); any member sees them.
 */

export interface WhatsAppNumber {
  /** Meta's «phone number ID» (digits). */
  readonly phoneNumberId: string;
  /** «+591 67680091», as visitors see it; null when the operator did not write it. */
  readonly displayPhone: string | null;
  readonly createdAt: string;
}

export type WhatsAppNumbersOutcome =
  | { readonly status: "updated"; readonly numbers: readonly WhatsAppNumber[] }
  | {
      readonly status:
        "invalid" | "display" | "taken" | "too_many" | "not_found" | "forbidden" | "error";
    };

export interface PlatformWhatsAppRepository {
  /** Null: not the operator with its second factor. */
  list(tenantId: string): Promise<WhatsAppNumber[] | null>;
  add(
    tenantId: string,
    phoneNumberId: string,
    displayPhone: string | null,
  ): Promise<WhatsAppNumbersOutcome>;
  remove(tenantId: string, phoneNumberId: string): Promise<WhatsAppNumbersOutcome>;
}

export interface WhatsAppNumberRepository {
  /** The municipality's numbers; none before the migration. */
  numbers(tenantId: string): Promise<WhatsAppNumber[]>;
}

export const PHONE_NUMBER_ID = /^[0-9]{5,30}$/u;

/** «+591 67680091»: a plus, the country code and digits, spaces allowed. */
export function parseDisplayPhone(value: unknown): string | null | false {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return false;
  const text = value
    .replace(/[-().]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (text === "") return null;
  return /^\+[0-9][0-9 ]{6,24}$/u.test(text) ? text : false;
}

/** wa.me link of a number written for visitors. */
export function whatsappChatHref(displayPhone: string): string {
  return `https://wa.me/${displayPhone.replace(/\D/gu, "")}`;
}

export async function addWhatsAppNumber(
  repository: PlatformWhatsAppRepository,
  tenantId: unknown,
  phoneNumberId: unknown,
  displayPhone: unknown,
): Promise<WhatsAppNumbersOutcome> {
  if (typeof tenantId !== "string" || tenantId === "") return { status: "invalid" };
  const id = typeof phoneNumberId === "string" ? phoneNumberId.trim() : "";
  if (!PHONE_NUMBER_ID.test(id)) return { status: "invalid" };
  const display = parseDisplayPhone(displayPhone);
  if (display === false) return { status: "display" };
  return repository.add(tenantId, id, display);
}

export async function removeWhatsAppNumber(
  repository: PlatformWhatsAppRepository,
  tenantId: unknown,
  phoneNumberId: unknown,
): Promise<WhatsAppNumbersOutcome> {
  if (typeof tenantId !== "string" || tenantId === "" || typeof phoneNumberId !== "string") {
    return { status: "invalid" };
  }
  return repository.remove(tenantId, phoneNumberId);
}
