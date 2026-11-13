import { describe, expect, it } from "vitest";

import { formatVoucherCode, isRedeemPin, normalizeVoucherCode, voucherUsable } from "./rewards";
import {
  parseStoredPassport,
  rememberVoucher,
  serializePassport,
  type StoredPassport,
} from "./stamps";

describe("a voucher's code", () => {
  it("is read as the shop types it", () => {
    expect(normalizeVoucherCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeVoucherCode(" M5WF U54M ")).toBe("M5WFU54M");
    expect(formatVoucherCode("M5WFU54M")).toBe("M5WF-U54M");
  });

  it("never has 0, O, 1 or I, and is 8 characters", () => {
    for (const code of [
      "ABCD-EFG0",
      "ABCDOFGH",
      "ABCD1FGH",
      "ABCDIFGH",
      "ABCDEFG",
      "ABCDEFGHJ",
      "",
      42,
    ]) {
      expect(normalizeVoucherCode(code)).toBeNull();
    }
  });
});

describe("the shop's key", () => {
  it("is 4 to 8 digits", () => {
    expect(["2468", "12345678"].map(isRedeemPin)).toEqual([true, true]);
    expect(["123", "123456789", "12a4", 2468].map(isRedeemPin)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("a voucher kept by the phone", () => {
  const passport: StoredPassport = { id: "AbCdEfGhIjKlMnOpQrSt_-", stamps: {} };
  const voucher = { code: "M5WFU54M", expiresAt: "2026-12-13T12:00:00.000Z", redeemedAt: null };

  it("goes and comes back with the passport, by circuit", () => {
    const kept = rememberVoucher(passport, "ruta-del-valle", voucher);
    expect(parseStoredPassport(serializePassport(kept))).toEqual(kept);
    // A passport from before the prize has no vouchers.
    expect(parseStoredPassport(serializePassport(passport))).toEqual(passport);
  });

  it("leaves out what is not a voucher", () => {
    const raw = JSON.stringify({
      v: 1,
      id: passport.id,
      stamps: {},
      vouchers: { ruta: voucher, otra: { ...voucher, code: "0000" }, "Mal Nombre": voucher },
    });
    expect(Object.keys(parseStoredPassport(raw)?.vouchers ?? {})).toEqual(["ruta"]);
  });

  it("can be redeemed until it is redeemed or expires", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    expect(voucherUsable(voucher, now)).toBe(true);
    expect(voucherUsable({ ...voucher, redeemedAt: "2026-11-15T12:00:00Z" }, now)).toBe(false);
    expect(voucherUsable(voucher, new Date("2026-12-14T00:00:00Z"))).toBe(false);
  });
});
