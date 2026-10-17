import { describe, expect, it } from "vitest";

import type { Actor, OrganizationMembership } from "../../contracts/organization";
import { normalizeEmail, normalizeOneTimeCode } from "../../domain/identity/email";
import { listMyOrganizations, openOrganization } from "./organizations";
import type { AuthGateway, EmailCodeRequestOutcome, MembershipReader } from "./ports";
import { requestSignInCode, verifySignInCode } from "./sign-in";

function gateway(overrides: Partial<AuthGateway> = {}): AuthGateway & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async requestEmailCode(email) {
      requested.push(email);
      return "sent";
    },
    verifyEmailCode: async () => "signed_in",
    exchangeAuthCode: async () => true,
    currentActor: async () => null,
    signOut: async () => undefined,
    ...overrides,
  };
}

describe("email and code normalization", () => {
  it.each([
    [" Owner@Example.Test ", "owner@example.test"],
    ["a.b+c@sub.example.bo", "a.b+c@sub.example.bo"],
  ])("accepts %s", (raw, expected) => expect(normalizeEmail(raw)).toBe(expected));

  it.each([
    null,
    42,
    "",
    "no-at-sign",
    "a@b",
    "a b@example.test",
    `${"a".repeat(65)}@example.test`,
  ])("rejects %s", (raw) => expect(normalizeEmail(raw)).toBeNull());

  it("normalizes six-digit codes and rejects anything else", () => {
    expect(normalizeOneTimeCode("123 456")).toBe("123456");
    expect(normalizeOneTimeCode("12345")).toBeNull();
    expect(normalizeOneTimeCode("abcdef")).toBeNull();
    expect(normalizeOneTimeCode(undefined)).toBeNull();
  });
});

describe("requestSignInCode", () => {
  it("does not reveal whether an account exists", async () => {
    const known = await requestSignInCode(
      "owner@example.test",
      gateway(),
      "http://app.localhost:3000/auth/callback",
    );
    const unknown = await requestSignInCode(
      "nobody@example.test",
      gateway({ requestEmailCode: async (): Promise<EmailCodeRequestOutcome> => "not_allowed" }),
      "http://app.localhost:3000/auth/callback",
    );
    expect(known).toEqual({ status: "code_sent", email: "owner@example.test" });
    expect(unknown).toEqual({ status: "code_sent", email: "nobody@example.test" });
  });

  it("validates the email before calling the provider", async () => {
    const g = gateway();
    expect(await requestSignInCode("not-an-email", g, "x")).toEqual({ status: "invalid_email" });
    expect(g.requested).toEqual([]);
  });

  it("surfaces rate limiting and outages", async () => {
    expect(
      await requestSignInCode(
        "a@example.test",
        gateway({ requestEmailCode: async () => "rate_limited" }),
        "x",
      ),
    ).toEqual({
      status: "rate_limited",
    });
    expect(
      await requestSignInCode(
        "a@example.test",
        gateway({ requestEmailCode: async () => "unavailable" }),
        "x",
      ),
    ).toEqual({
      status: "unavailable",
    });
  });
});

describe("verifySignInCode", () => {
  it("rejects malformed input without calling the provider", async () => {
    let called = false;
    const g = gateway({
      verifyEmailCode: async () => {
        called = true;
        return "signed_in";
      },
    });
    expect(await verifySignInCode("a@example.test", "12", g)).toEqual({ status: "invalid_input" });
    expect(called).toBe(false);
  });

  it("passes through the provider outcome", async () => {
    expect(
      await verifySignInCode(
        "a@example.test",
        "123456",
        gateway({ verifyEmailCode: async () => "invalid_code" }),
      ),
    ).toEqual({
      status: "invalid_code",
    });
  });
});

describe("organizations", () => {
  const actor: Actor = { userId: "00000000-0000-4000-8000-0000000000ab", email: "ab@example.test" };
  const memberships: OrganizationMembership[] = [
    {
      tenantId: "5eed1000-0000-4000-8000-000000000002",
      slug: "sur",
      displayName: "Sur",
      role: "analyst",
    },
    {
      tenantId: "5eed1000-0000-4000-8000-000000000001",
      slug: "norte",
      displayName: "Norte",
      role: "editor",
    },
  ];
  const reader: MembershipReader & { calls: string[] } = {
    calls: [],
    async listActiveMemberships(userId) {
      this.calls.push(userId);
      return memberships;
    },
  };

  it("lists the actor's organizations sorted by name, asking only for the actor's own memberships", async () => {
    const result = await listMyOrganizations(actor, reader);
    expect(result.map((m) => m.slug)).toEqual(["norte", "sur"]);
    expect(reader.calls.every((id) => id === actor.userId)).toBe(true);
  });

  it("opens only organizations the actor belongs to", async () => {
    expect((await openOrganization(actor, "norte", reader))?.role).toBe("editor");
    expect(await openOrganization(actor, "otro", reader)).toBeNull();
  });
});
