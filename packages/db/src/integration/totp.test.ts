import { describe, expect, it } from "vitest";

import { totp } from "./totp";

function base32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...bytes].map((byte) => byte.toString(2).padStart(8, "0")).join("");
  return (bits.match(/.{1,5}/gu) ?? [])
    .map((chunk) => alphabet[Number.parseInt(chunk.padEnd(5, "0"), 2)])
    .join("");
}

describe("TOTP test helper", () => {
  it("matches the RFC 6238 SHA-1 test vectors (last 6 digits)", () => {
    // Public RFC 6238 seed "12345678901234567890", base32-encoded here.
    const rfcSeed = base32(Buffer.from("12345678901234567890", "ascii"));
    expect(rfcSeed).toBe(["GEZDGNBV", "GY3TQOJQ"].join("").repeat(2));
    expect(totp(rfcSeed, 59_000)).toBe("287082");
    expect(totp(rfcSeed, 1_111_111_109_000)).toBe("081804");
    expect(totp(rfcSeed, 2_000_000_000_000)).toBe("279037");
  });
});
