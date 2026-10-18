/**
 * ZC-01 rehearsal against a REAL local Supabase stack: the platform operator signs in,
 * enrolls TOTP, provisions a new municipality, its owner accepts the invitation, the
 * operator puts it online and the portal resolves — no code or env change involved.
 */
import {
  inviteMember,
  listMembers,
  operatorGate,
  provisionTenant,
  resolvePortalPresentation,
  type OrganizationMembership,
} from "@rikuy/core";
import { beforeAll, describe, expect, it } from "vitest";

import { env, newSession, signIn, stackAvailable, USERS } from "./integration/local-stack";
import { totp } from "./integration/totp";
import {
  createInvitationRepository,
  createMemberRepository,
  createMfaGateway,
  createPlatformRepository,
  createSupabaseIdentityAdmin,
} from "./platform";
import { createSupabasePresentationReader } from "./tenant-config";
import { createSupabaseTenantDirectory } from "./tenant-directory";

const OPERATOR = "operador@rikuy.example.test";
const HOSTS = { rootDomain: "localhost", adminHost: "app.localhost:3000" };
// Deterministic in CI (the portal e2e step checks this host); unique for local reruns.
const SLUG = process.env.CI ? "zc-ensayo" : `zc-${Date.now().toString(36)}`;
const HOST = `${SLUG}.localhost`;
const OWNER = `propietaria@${SLUG}.example.test`;

describe.runIf(stackAvailable)("platform onboarding (ZC-01) against local Supabase", () => {
  let operator: Awaited<ReturnType<typeof signIn>>;
  let platform: ReturnType<typeof createPlatformRepository>;
  let identity: ReturnType<typeof createSupabaseIdentityAdmin>;
  let directory: ReturnType<typeof createSupabaseTenantDirectory>;

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    identity = createSupabaseIdentityAdmin({ url: env.url, secretKey: env.secretKey });
    directory = createSupabaseTenantDirectory({ url: env.url, publishableKey: env.publishableKey });
    operator = await signIn(OPERATOR);
    platform = createPlatformRepository(operator.client);
  });

  it("requires a second factor, enrolled and verified with a real TOTP code", async () => {
    const mfa = createMfaGateway(operator.client);
    expect(await platform.operatorAccess()).toBe("needs_mfa");
    // Provisioning is refused before the second factor, and no account gets created.
    expect(
      await provisionTenant(
        {
          displayName: "Antes de MFA",
          slug: `${SLUG}-x`,
          hostname: `${SLUG}-x.localhost`,
          ownerEmail: OWNER,
        },
        { platform, identity, hosts: HOSTS },
      ),
    ).toEqual({ status: "forbidden" });

    const gate = await operatorGate(platform, mfa);
    if (gate.status !== "enroll") {
      throw new Error(`unexpected gate ${gate.status}: run \`pnpm db:reset\` before rerunning`);
    }
    const enrollment = await mfa.enrollTotp();
    if (!enrollment) throw new Error("enrollment failed");
    expect(enrollment.qrCode.startsWith("data:image/svg+xml")).toBe(true);
    const { factorId, secret } = enrollment;

    expect(await mfa.verifyTotp(factorId, "000000")).toBe("invalid_code");
    expect(await mfa.verifyTotp(factorId, totp(secret))).toBe("verified");
    expect((await mfa.assurance()).current).toBe("aal2");
    expect(await platform.operatorAccess()).toBe("ok");
  });

  it("provisions a municipality, the owner accepts and it goes live without code changes", async () => {
    const result = await provisionTenant(
      { displayName: "Ensayo ZC-01", slug: SLUG, hostname: HOST, ownerEmail: OWNER },
      { platform, identity, hosts: HOSTS },
    );
    expect(result.status).toBe("provisioned");
    if (result.status !== "provisioned") return;

    // Not public while provisioning, and it cannot go live before the owner accepts.
    expect(await directory.findByHost(HOST)).toBeNull();
    expect(await platform.setStatus(result.tenantId, "active")).toEqual({
      status: "owner_pending",
    });

    // Same slug or host again → rejected.
    expect(
      await provisionTenant(
        {
          displayName: "Duplicado",
          slug: SLUG,
          hostname: `${SLUG}-otro.localhost`,
          ownerEmail: OWNER,
        },
        { platform, identity, hosts: HOSTS },
      ),
    ).toEqual({ status: "slug_taken" });

    const owner = await signIn(OWNER);
    const invitations = createInvitationRepository(owner.client);
    const pending = await invitations.listPending();
    expect(pending.map((i) => [i.slug, i.role])).toEqual([[SLUG, "owner"]]);
    expect(await invitations.accept(result.tenantId)).toBe("accepted");

    // The owner can already prepare the municipality while it is provisioning.
    const [membership] = await owner.reader.listActiveMemberships(owner.actor.userId);
    expect(membership).toMatchObject({ slug: SLUG, role: "owner", tenantStatus: "provisioning" });

    expect(await platform.setStatus(result.tenantId, "active")).toEqual({ status: "updated" });
    const live = await directory.findByHost(HOST);
    expect(live).toMatchObject({ slug: SLUG, displayName: "Ensayo ZC-01", isCanonical: true });
    if (live === null) return;
    const presentation = await resolvePortalPresentation(
      live,
      createSupabasePresentationReader({ url: env.url, publishableKey: env.publishableKey }),
    );
    expect(presentation.source).toBe("default");
    expect(presentation.presentation.identity.siteName).toBe("Ensayo ZC-01");

    // The new owner manages their own team.
    const ownerMembership = membership as OrganizationMembership;
    const members = createMemberRepository(owner.client);
    expect(
      await inviteMember(
        ownerMembership,
        { email: `guia@${SLUG}.example.test`, role: "editor" },
        { members, identity },
      ),
    ).toEqual({ status: "done" });
    expect(
      (await listMembers(ownerMembership, members))?.map((m) => [m.role, m.status]).sort(),
    ).toEqual([
      ["editor", "invited"],
      ["owner", "active"],
    ]);
  });

  it("a tenant owner is not an operator", async () => {
    const session = newSession();
    const ownerNorte = await signIn(USERS.ownerNorte);
    const repo = createPlatformRepository(ownerNorte.client);
    expect(await repo.operatorAccess()).toBe("none");
    expect(await repo.setStatus("5eed1000-0000-4000-8000-000000000002", "suspended")).toEqual({
      status: "forbidden",
    });
    expect(session.jar.size).toBe(0);
  });
});
