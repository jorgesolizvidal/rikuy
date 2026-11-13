import { describe, expect, it, vi } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import {
  canSetRedeemPin,
  redeemVoucher,
  requestVoucher,
  setRedeemPin,
  type PassportRewardRepository,
  type PublishedRewardReader,
} from "./rewards";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const PLACE = "11111111-1111-4111-8111-111111111111";
const PASSPORT = "AbCdEfGhIjKlMnOpQrSt_-";
const STAMP = { placeId: PLACE, at: 1_800_000_000, located: true, signature: "a".repeat(43) };

function reader(): PublishedRewardReader {
  return {
    requestVoucher: vi.fn(async () => ({ status: "incomplete" as const, missing: 1 })),
    redeemVoucher: vi.fn(async () => ({ status: "wrong" as const })),
  };
}

function member(role: OrganizationMembership["role"]): OrganizationMembership {
  return { tenantId: TENANT, slug: "demo", displayName: "Demo", role } as OrganizationMembership;
}

describe("asking for the prize", () => {
  it("sends the circuit, the passport and only the stamps' signed fields", async () => {
    const r = reader();
    await requestVoucher(r, TENANT, {
      circuit: "ruta-del-valle",
      passport: PASSPORT,
      stamps: [{ ...STAMP, slug: "plaza", title: "Plaza" }],
    });
    expect(r.requestVoucher).toHaveBeenCalledWith(TENANT, "ruta-del-valle", PASSPORT, [STAMP]);
  });

  it("refuses what is not well formed without asking", async () => {
    const r = reader();
    for (const body of [
      null,
      { circuit: "Ruta", passport: PASSPORT, stamps: [] },
      { circuit: "ruta", passport: "corto", stamps: [] },
      { circuit: "ruta", passport: PASSPORT, stamps: "no" },
      { circuit: "ruta", passport: PASSPORT, stamps: [{ ...STAMP, at: 1.5 }] },
      { circuit: "ruta", passport: PASSPORT, stamps: [{ ...STAMP, signature: "x" }] },
      { circuit: "ruta", passport: PASSPORT, stamps: Array.from({ length: 61 }, () => STAMP) },
    ]) {
      expect(await requestVoucher(r, TENANT, body)).toEqual({ status: "invalid" });
    }
    expect(r.requestVoucher).not.toHaveBeenCalled();
  });
});

describe("redeeming", () => {
  it("normalizes the code and passes whether to redeem", async () => {
    const r = reader();
    await redeemVoucher(r, TENANT, { code: "m5wf-u54m", pin: "2468", redeem: false });
    expect(r.redeemVoucher).toHaveBeenCalledWith(TENANT, "M5WFU54M", "2468", false);
  });

  it("refuses a malformed code or key without asking", async () => {
    const r = reader();
    for (const body of [
      { code: "M5WF-U540", pin: "2468", redeem: true },
      { code: "M5WFU54M", pin: "24", redeem: true },
      { code: "M5WFU54M", pin: "2468" },
      "M5WFU54M",
    ]) {
      expect(await redeemVoucher(r, TENANT, body)).toEqual({ status: "invalid" });
    }
    expect(r.redeemVoucher).not.toHaveBeenCalled();
  });
});

describe("the shop's key in the panel", () => {
  it("is set only by owners and admins, as 4 to 8 digits", async () => {
    expect(["owner", "admin", "editor", "analyst"].map((r) => canSetRedeemPin(r as never))).toEqual(
      [true, true, false, false],
    );
    const repo: PassportRewardRepository = {
      pins: vi.fn(async () => []),
      setPin: vi.fn(async () => ({ status: "saved" as const, pinSetAt: "2026-11-13T00:00:00Z" })),
    };
    expect(await setRedeemPin(member("editor"), repo, "c", "2468")).toEqual({
      status: "forbidden",
    });
    expect(await setRedeemPin(member("owner"), repo, "c", "12")).toEqual({ status: "invalid" });
    expect(repo.setPin).not.toHaveBeenCalled();
    expect(await setRedeemPin(member("admin"), repo, "c", "2468")).toMatchObject({
      status: "saved",
    });
    expect(repo.setPin).toHaveBeenCalledWith(TENANT, "c", "2468");
  });
});
