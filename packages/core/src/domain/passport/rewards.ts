/**
 * The prize of the tourist passport (C2 · Paso 3, ADR-058): the voucher's short code and the
 * shop's key. Pure and without schemas: the browser uses it through
 * `@rikuy/core/passport-client`.
 */

/** 8 characters without 0, O, 1 or I, so they are read aloud and typed without mistakes. */
const VOUCHER_CODE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u;
const REDEEM_PIN = /^[0-9]{4,8}$/u;

/** A voucher's code as typed by the shop («abcd-efgh», with spaces), or null. */
export function normalizeVoucherCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 40) return null;
  const code = input.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  return VOUCHER_CODE.test(code) ? code : null;
}

/** «ABCD-EFGH»: how the visitor reads it out. */
export function formatVoucherCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The shop's key: 4 to 8 digits. */
export function isRedeemPin(value: unknown): value is string {
  return typeof value === "string" && REDEEM_PIN.test(value);
}

/** Whether a voucher can still be redeemed: not redeemed and not expired. */
export function voucherUsable(
  voucher: { readonly expiresAt: string; readonly redeemedAt: string | null },
  now: Date,
): boolean {
  return voucher.redeemedAt === null && Date.parse(voucher.expiresAt) > now.getTime();
}
