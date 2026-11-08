import { createHmac } from "node:crypto";

import type { Page } from "playwright-core";

/**
 * TOTP secret of the seeded demo owners (supabase/seed.sql): owners and admins act only
 * with a second factor (ADR-043). Synthetic and local only.
 */
export const SEED_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) from a base32 secret. */
export function totp(secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/u, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error("Invalid base32 secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/gu) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/**
 * After the email code, passes /verificacion the way a person does: types the code of the
 * app. Does nothing for someone who does not need it (the page sends them on). Tries the
 * neighbour window when a code of this window was already used.
 */
export async function passSecondFactor(page: Page, admin: string, secret = SEED_TOTP_SECRET) {
  await page.goto(`${admin}/verificacion`);
  for (const offset of [0, 30_000, -30_000]) {
    if (!new URL(page.url()).pathname.startsWith("/verificacion")) return;
    await page.getByLabel("Código de 6 dígitos").fill(totp(secret, Date.now() + offset));
    await page.getByRole("button", { name: "Verificar" }).click();
    const left = await page
      .waitForURL((url) => !url.pathname.startsWith("/verificacion"), { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (left) return;
  }
  throw new Error("could not pass the second factor");
}
