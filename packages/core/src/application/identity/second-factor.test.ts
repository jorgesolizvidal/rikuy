import { describe, expect, it } from "vitest";

import type { Actor, OrganizationMembership } from "../../contracts/organization";
import type { MfaGateway } from "../platform/ports";
import { openOrganization, organizationAccess } from "./organizations";
import type { MembershipReader } from "./ports";
import {
  safePanelPath,
  secondFactorGate,
  startStaffEnrollment,
  verifyStaffCode,
} from "./second-factor";

const ACTOR: Actor = { userId: "5eed0000-0000-4000-8000-000000000001", email: "a@example.test" };
const NORTE: OrganizationMembership = {
  tenantId: "5eed1000-0000-4000-8000-000000000001",
  slug: "norte",
  displayName: "Norte",
  role: "owner",
  tenantStatus: "active",
  needsSecondFactor: true,
};
const SUR: OrganizationMembership = {
  tenantId: "5eed1000-0000-4000-8000-000000000002",
  slug: "sur",
  displayName: "Sur",
  role: "editor",
  tenantStatus: "active",
};

const reader = (memberships: OrganizationMembership[]): MembershipReader => ({
  listActiveMemberships: async () => memberships,
});

function mfa(factors: string[]) {
  const calls: string[] = [];
  const gateway: MfaGateway = {
    assurance: async () => ({ current: "aal1", next: factors.length ? "aal2" : "aal1" }),
    verifiedTotpFactorIds: async () => factors,
    async enrollTotp() {
      calls.push("enroll");
      return { factorId: "new", qrCode: "data:image/svg+xml,", secret: "JBSWY3DPEHPK3PXP" };
    },
    async verifyTotp(factorId, code) {
      calls.push(`verify:${factorId}:${code}`);
      return "verified";
    },
  };
  return { gateway, calls };
}

describe("opening a municipality without the second factor", () => {
  it("lists it but does not open it", async () => {
    const both = reader([NORTE, SUR]);
    expect(await organizationAccess(ACTOR, "norte", both)).toEqual({
      status: "second_factor",
      membership: NORTE,
    });
    expect(await openOrganization(ACTOR, "norte", both)).toBeNull();
    expect(await openOrganization(ACTOR, "sur", both)).toEqual(SUR);
    expect(await organizationAccess(ACTOR, "otro", both)).toEqual({ status: "not_found" });
  });
});

describe("the second-factor gate", () => {
  it("is not needed when no membership asks for it", async () => {
    const { gateway, calls } = mfa([]);
    expect(await secondFactorGate(ACTOR, reader([SUR]), gateway)).toEqual({ status: "not_needed" });
    expect(await startStaffEnrollment(ACTOR, reader([SUR]), gateway)).toBeNull();
    expect(await verifyStaffCode(ACTOR, reader([SUR]), gateway, "f", "123456")).toBe("not_needed");
    expect(calls).toEqual([]);
  });

  it("enrolls someone without a factor and verifies the new one", async () => {
    const { gateway, calls } = mfa([]);
    expect(await secondFactorGate(ACTOR, reader([NORTE]), gateway)).toEqual({ status: "enroll" });
    expect(await startStaffEnrollment(ACTOR, reader([NORTE]), gateway)).toMatchObject({
      factorId: "new",
    });
    expect(await verifyStaffCode(ACTOR, reader([NORTE]), gateway, "new", "123 456")).toBe(
      "verified",
    );
    expect(calls).toEqual(["enroll", "verify:new:123456"]);
  });

  it("asks for the code of an existing factor and never enrolls a second one", async () => {
    const { gateway, calls } = mfa(["f1"]);
    expect(await secondFactorGate(ACTOR, reader([NORTE, SUR]), gateway)).toEqual({
      status: "verify",
      factorId: "f1",
    });
    expect(await startStaffEnrollment(ACTOR, reader([NORTE]), gateway)).toBeNull();
    expect(await verifyStaffCode(ACTOR, reader([NORTE]), gateway, "f1", "12a456")).toBe(
      "invalid_code",
    );
    expect(await verifyStaffCode(ACTOR, reader([NORTE]), gateway, 5, "123456")).toBe(
      "invalid_code",
    );
    expect(calls).toEqual([]);
  });

  it("only follows relative panel paths after verifying", () => {
    expect(safePanelPath("/o/demo-norte")).toBe("/o/demo-norte");
    expect(safePanelPath("//evil.example")).toBe("/");
    expect(safePanelPath("https://evil.example")).toBe("/");
    expect(safePanelPath("/o/x?y=1")).toBe("/");
    expect(safePanelPath(undefined)).toBe("/");
  });
});
