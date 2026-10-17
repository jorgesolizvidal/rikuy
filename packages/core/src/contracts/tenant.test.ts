import { describe, expect, it } from "vitest";

import { decodeTenantContext, encodeTenantContext, type TenantContext } from "./tenant";

const context: TenantContext = {
  version: 1,
  host: "demo-norte.localhost",
  tenant: {
    tenantId: "5eed1000-0000-4000-8000-000000000001",
    slug: "demo-norte",
    displayName: "Municipio Ñandú — Peña",
    defaultLocale: "es",
    timezone: "America/La_Paz",
    canonicalHost: "demo-norte.localhost",
    isCanonical: true,
    activeConfigId: null,
  },
};

describe("tenant context header codec", () => {
  it("round-trips, including non-ASCII names, as an ASCII-only header value", () => {
    const encoded = encodeTenantContext(context);
    expect(encoded).toMatch(/^[\x20-\x7e]+$/);
    expect(decodeTenantContext(encoded)).toEqual(context);
  });

  it.each([null, "", "not-json", encodeURIComponent('{"version":2}'), "%E0%A4%A"])(
    "rejects %s without throwing",
    (value) => {
      expect(decodeTenantContext(value)).toBeNull();
    },
  );

  it("rejects contexts with unexpected shapes", () => {
    const tampered = encodeURIComponent(
      JSON.stringify({ ...context, tenant: { ...context.tenant, tenantId: "not-a-uuid" } }),
    );
    expect(decodeTenantContext(tampered)).toBeNull();
  });
});
