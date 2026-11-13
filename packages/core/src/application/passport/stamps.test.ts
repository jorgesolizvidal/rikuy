import { describe, expect, it, vi } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import {
  canRenewStampCodes,
  canSeeStampCodes,
  collectStamp,
  loadStampCodes,
  renewStampCode,
  stampUrl,
  type PublishedStampReader,
  type StampCodeRepository,
} from "./stamps";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const PLACE = "11111111-1111-4111-8111-111111111111";
const CODE = "7qVtpcGPSWzBExzRe9Bp4w";
const PASSPORT = "AbCdEfGhIjKlMnOpQrSt_-";

function member(role: OrganizationMembership["role"]): OrganizationMembership {
  return { tenantId: TENANT, slug: "demo", displayName: "Demo", role } as OrganizationMembership;
}

function repository(): StampCodeRepository {
  return {
    list: vi.fn(async () => []),
    renew: vi.fn(async () => ({ status: "renewed" as const, version: 2 })),
  };
}

describe("stamp codes in the panel", () => {
  it("are seen by owners, admins and editors; renewed only by owners and admins", () => {
    expect(
      ["owner", "admin", "editor", "analyst"].map((r) => canSeeStampCodes(r as never)),
    ).toEqual([true, true, true, false]);
    expect(
      ["owner", "admin", "editor", "analyst"].map((r) => canRenewStampCodes(r as never)),
    ).toEqual([true, true, false, false]);
  });

  it("are not even asked for an analyst", async () => {
    const repo = repository();
    expect(await loadStampCodes(member("analyst"), repo)).toBeNull();
    expect(repo.list).not.toHaveBeenCalled();
    expect(await loadStampCodes(member("editor"), repo)).toEqual([]);
  });

  it("are renewed with the version the person saw", async () => {
    const repo = repository();
    expect(await renewStampCode(member("editor"), repo, PLACE, 1)).toEqual({ status: "forbidden" });
    expect(repo.renew).not.toHaveBeenCalled();
    expect(await renewStampCode(member("admin"), repo, PLACE, 1)).toEqual({
      status: "renewed",
      version: 2,
    });
    expect(repo.renew).toHaveBeenCalledWith(TENANT, PLACE, 1);
  });

  it("open the stamp page of the portal", () => {
    expect(stampUrl("https://rikuy-ucurena.vercel.app", CODE)).toBe(
      `https://rikuy-ucurena.vercel.app/sello/${CODE}`,
    );
  });
});

describe("collecting a stamp", () => {
  const stamp = {
    placeId: PLACE,
    slug: "plaza",
    title: "Plaza",
    at: 1_800_000_000,
    located: true,
    signature: "a".repeat(43),
  };

  function reader(found = true): PublishedStampReader {
    return {
      place: vi.fn(async () => null),
      collect: vi.fn(async () => (found ? stamp : null)),
    };
  }

  it("asks the server with the code, the passport and «near»", async () => {
    const r = reader();
    expect(
      await collectStamp(r, TENANT, { code: CODE, passport: PASSPORT, located: true }),
    ).toEqual({ status: "stamped", stamp });
    expect(r.collect).toHaveBeenCalledWith(TENANT, CODE, PASSPORT, true);
  });

  it("refuses what is not well formed without asking", async () => {
    const r = reader();
    for (const body of [
      null,
      "texto",
      { code: "corto", passport: PASSPORT, located: true },
      { code: CODE, passport: "corto", located: true },
      { code: CODE, passport: PASSPORT, located: "sí" },
      // The position itself is never part of the request.
      { code: CODE, passport: PASSPORT },
    ]) {
      expect(await collectStamp(r, TENANT, body)).toEqual({ status: "invalid" });
    }
    expect(r.collect).not.toHaveBeenCalled();
  });

  it("is nothing for a code that does not stamp", async () => {
    expect(
      await collectStamp(reader(false), TENANT, { code: CODE, passport: PASSPORT, located: false }),
    ).toEqual({ status: "not_found" });
  });
});
