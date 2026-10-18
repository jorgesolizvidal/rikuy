import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import { isValidSlug, suggestSlug } from "../../domain/tenancy/slug";
import {
  acceptInvitation,
  assignableRoles,
  canAssignRole,
  changeMemberRole,
  inviteMember,
  listMembers,
  revokeMember,
} from "./members";
import {
  changeTenantStatus,
  listPlatformTenants,
  operatorGate,
  provisionTenant,
  startOperatorEnrollment,
  suggestPortalHostname,
  verifyOperatorCode,
} from "./platform";
import type {
  IdentityAdmin,
  MemberRepository,
  MfaGateway,
  OperatorAccess,
  PlatformRepository,
} from "./ports";

const HOSTS = { rootDomain: "localhost", adminHost: "app.localhost:3000" };
const TENANT = "5eed1000-0000-4000-8000-000000000001";

function platform(access: OperatorAccess, overrides: Partial<PlatformRepository> = {}) {
  const calls: string[] = [];
  const repo: PlatformRepository = {
    operatorAccess: async () => access,
    listTenants: async () => [],
    async provision(request) {
      calls.push(`provision:${request.slug}:${request.hostname}:${request.ownerUserId}`);
      return { status: "provisioned", tenantId: TENANT };
    },
    async setStatus(tenantId, status) {
      calls.push(`status:${tenantId}:${status}`);
      return { status: "updated" };
    },
    ...overrides,
  };
  return { repo, calls };
}

function identity() {
  const emails: string[] = [];
  const admin: IdentityAdmin = {
    async ensureUser(email) {
      emails.push(email);
      return { userId: "user-for-" + email, created: true };
    },
  };
  return { admin, emails };
}

function mfa(factors: string[] = []) {
  const calls: string[] = [];
  const gateway: MfaGateway = {
    assurance: async () => ({ current: "aal1", next: factors.length ? "aal2" : "aal1" }),
    verifiedTotpFactorIds: async () => factors,
    async enrollTotp() {
      calls.push("enroll");
      return { factorId: "f1", qrCode: "data:image/svg+xml;utf8,<svg/>", secret: "ABC" };
    },
    async verifyTotp(factorId, code) {
      calls.push(`verify:${factorId}:${code}`);
      return "verified";
    },
  };
  return { gateway, calls };
}

describe("slugs and hosts", () => {
  it.each([
    ["Ucureña", "ucurena"],
    ["Villa Peña (Norte)", "villa-pena-norte"],
    ["  San José de Chiquitos ", "san-jose-de-chiquitos"],
  ])("suggests %s → %s", (name, slug) => expect(suggestSlug(name)).toBe(slug));

  it("validates slugs like the database does", () => {
    expect(isValidSlug("demo-norte")).toBe(true);
    for (const bad of ["app", "Demo", "-x", "x-", "a_b", ""]) expect(isValidSlug(bad)).toBe(false);
  });

  it("suggests the platform subdomain", () => {
    expect(suggestPortalHostname("demo-este", HOSTS)).toBe("demo-este.localhost");
  });
});

describe("operator gate (MFA)", () => {
  it("denies non-operators and never enrolls a factor for them", async () => {
    const m = mfa();
    expect(await operatorGate(platform("none").repo, m.gateway)).toEqual({ status: "denied" });
    expect(await startOperatorEnrollment(platform("none").repo, m.gateway)).toBeNull();
    expect(await verifyOperatorCode(platform("none").repo, m.gateway, "f1", "123456")).toBe(
      "denied",
    );
    expect(m.calls).toEqual([]);
  });

  it("asks an operator without a factor to enroll, and one with a factor to verify", async () => {
    expect(await operatorGate(platform("needs_mfa").repo, mfa().gateway)).toEqual({
      status: "enroll",
    });
    expect(await operatorGate(platform("needs_mfa").repo, mfa(["f9"]).gateway)).toEqual({
      status: "verify",
      factorId: "f9",
    });
    expect(await operatorGate(platform("ok").repo, mfa(["f9"]).gateway)).toEqual({
      status: "granted",
    });
  });

  it("verifies only well-formed codes", async () => {
    const m = mfa(["f1"]);
    expect(await verifyOperatorCode(platform("needs_mfa").repo, m.gateway, "f1", "12a456")).toBe(
      "invalid_code",
    );
    expect(await verifyOperatorCode(platform("needs_mfa").repo, m.gateway, "f1", " 123 456 ")).toBe(
      "verified",
    );
    expect(m.calls).toEqual(["verify:f1:123456"]);
  });

  it("lists tenants only with a verified second factor", async () => {
    expect(await listPlatformTenants(platform("needs_mfa").repo)).toBeNull();
    expect(await listPlatformTenants(platform("ok").repo)).toEqual([]);
  });
});

describe("provisioning", () => {
  const valid = {
    displayName: "  Municipio Demo Este ",
    slug: "Demo-Este",
    hostname: "demo-este.localhost",
    ownerEmail: " Duena@Demo-Este.example.test ",
  };

  it("creates the owner account only after the operator check, then provisions", async () => {
    const p = platform("ok");
    const id = identity();
    expect(
      await provisionTenant(valid, { platform: p.repo, identity: id.admin, hosts: HOSTS }),
    ).toEqual({
      status: "provisioned",
      tenantId: TENANT,
    });
    expect(id.emails).toEqual(["duena@demo-este.example.test"]);
    expect(p.calls).toEqual([
      "provision:demo-este:demo-este.localhost:user-for-duena@demo-este.example.test",
    ]);
  });

  it.each(["none", "needs_mfa"] as const)(
    "refuses %s without creating any account",
    async (access) => {
      const id = identity();
      const result = await provisionTenant(valid, {
        platform: platform(access).repo,
        identity: id.admin,
        hosts: HOSTS,
      });
      expect(result).toEqual({ status: "forbidden" });
      expect(id.emails).toEqual([]);
    },
  );

  it.each([
    [{ slug: "app" }, ["slug"]],
    [{ hostname: "app.localhost:3000" }, ["hostname"]],
    [{ hostname: "localhost" }, ["hostname"]],
    [{ hostname: "x.localhost/path" }, ["hostname"]],
    [{ hostname: "x.localhost:4000" }, ["hostname"]],
    [{ ownerEmail: "nope" }, ["ownerEmail"]],
    [{ displayName: "   " }, ["displayName"]],
  ])("rejects invalid input %j", async (patch, fields) => {
    const id = identity();
    expect(
      await provisionTenant(
        { ...valid, ...patch },
        { platform: platform("ok").repo, identity: id.admin, hosts: HOSTS },
      ),
    ).toEqual({ status: "invalid_input", fields });
    expect(id.emails).toEqual([]);
  });

  it("only allows activation or suspension", async () => {
    const p = platform("ok");
    expect(await changeTenantStatus(p.repo, TENANT, "deleted")).toEqual({
      status: "invalid_transition",
    });
    expect(await changeTenantStatus(p.repo, TENANT, "active")).toEqual({ status: "updated" });
    expect(p.calls).toEqual([`status:${TENANT}:active`]);
  });
});

describe("members", () => {
  const as = (role: OrganizationMembership["role"]): OrganizationMembership => ({
    tenantId: TENANT,
    slug: "demo-norte",
    displayName: "Municipio Demo Norte",
    role,
    tenantStatus: "active",
  });

  function members() {
    const calls: string[] = [];
    const repo: MemberRepository = {
      list: async () => [],
      async add(_t, userId, role) {
        calls.push(`add:${userId}:${role}`);
        return { status: "done" };
      },
      async changeRole(_t, id, role) {
        calls.push(`role:${id}:${role}`);
        return { status: "done" };
      },
      async revoke(_t, id) {
        calls.push(`revoke:${id}`);
        return { status: "done" };
      },
    };
    return { repo, calls };
  }

  it("applies the role rules", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "editor", "analyst"]);
    expect(assignableRoles("admin")).toEqual(["editor", "analyst"]);
    expect(assignableRoles("editor")).toEqual([]);
    expect(canAssignRole("admin", "owner", null)).toBe(false);
    expect(canAssignRole("admin", "editor", "analyst")).toBe(true);
  });

  it("lists members only for owners and admins", async () => {
    expect(await listMembers(as("editor"), members().repo)).toBeNull();
    expect(await listMembers(as("admin"), members().repo)).toEqual([]);
  });

  it("authorizes before creating an account for the invitee", async () => {
    const id = identity();
    const m = members();
    expect(
      await inviteMember(
        as("admin"),
        { email: "x@example.test", role: "admin" },
        { members: m.repo, identity: id.admin },
      ),
    ).toEqual({ status: "forbidden" });
    expect(
      await inviteMember(
        as("analyst"),
        { email: "x@example.test", role: "editor" },
        { members: m.repo, identity: id.admin },
      ),
    ).toEqual({ status: "forbidden" });
    expect(
      await inviteMember(
        as("owner"),
        { email: "bad", role: "editor" },
        { members: m.repo, identity: id.admin },
      ),
    ).toEqual({ status: "invalid_email" });
    expect(id.emails).toEqual([]);
    expect(
      await inviteMember(
        as("admin"),
        { email: "Nuevo@Example.test", role: "editor" },
        { members: m.repo, identity: id.admin },
      ),
    ).toEqual({ status: "done" });
    expect(m.calls).toEqual(["add:user-for-nuevo@example.test:editor"]);
  });

  it("checks the current role of the target when changing or revoking", async () => {
    const m = members();
    expect(
      await changeMemberRole(
        as("admin"),
        { membershipId: "m1", role: "editor", currentRole: "owner" },
        m.repo,
      ),
    ).toEqual({ status: "forbidden" });
    expect(
      await revokeMember(as("admin"), { membershipId: "m1", currentRole: "admin" }, m.repo),
    ).toEqual({ status: "forbidden" });
    expect(
      await revokeMember(as("owner"), { membershipId: "m1", currentRole: "admin" }, m.repo),
    ).toEqual({ status: "done" });
    expect(m.calls).toEqual(["revoke:m1"]);
  });

  it("accepts invitations by tenant id only", async () => {
    const repo = { listPending: async () => [], accept: async () => "accepted" as const };
    expect(await acceptInvitation(repo, "")).toBe("not_found");
    expect(await acceptInvitation(repo, TENANT)).toBe("accepted");
  });
});
