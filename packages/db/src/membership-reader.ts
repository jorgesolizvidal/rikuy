import type { MembershipReader, OrganizationMembership } from "@rikuy/core";
import { z } from "zod";

import { isMissingFunction } from "./missing-function";
import type { SessionClient } from "./session-client";

const roleSchema = z.enum(["owner", "admin", "editor", "analyst"]);
const tenantStatusSchema = z.enum(["provisioning", "active", "suspended"]);

const rpcRowSchema = z.object({
  tenant_id: z.uuid(),
  slug: z.string(),
  display_name: z.string(),
  tenant_status: tenantStatusSchema,
  is_demo: z.boolean(),
  role: roleSchema,
  needs_second_factor: z.boolean(),
});

const legacyRowSchema = z.object({
  role: roleSchema,
  tenant: z.object({
    id: z.uuid(),
    slug: z.string(),
    display_name: z.string(),
    status: tenantStatusSchema,
    is_demo: z.boolean(),
  }),
});

interface Row {
  readonly tenantId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: z.infer<typeof tenantStatusSchema>;
  readonly demo: boolean;
  readonly role: z.infer<typeof roleSchema>;
  readonly needsSecondFactor: boolean;
}

function toMembership(row: Row): OrganizationMembership[] {
  if (row.status === "suspended") return [];
  return [
    {
      tenantId: row.tenantId,
      slug: row.slug,
      displayName: row.displayName,
      role: row.role,
      tenantStatus: row.status,
      ...(row.demo ? { demo: true } : {}),
      ...(row.needsSecondFactor ? { needsSecondFactor: true } : {}),
    },
  ];
}

/**
 * Active memberships of provisioning or active tenants (suspended tenants are hidden),
 * read with the user's own JWT through `my_memberships()`. That function also says which
 * ones need the second factor (ADR-043): an owner or admin without aal2 cannot read the
 * tenant row through RLS, yet the panel must list it and send them to /verificacion.
 */
export function createMembershipReader(client: SessionClient): MembershipReader {
  return {
    async listActiveMemberships(userId): Promise<OrganizationMembership[]> {
      const { data, error } = await client.rpc("my_memberships");
      if (error === null) {
        return z
          .array(rpcRowSchema)
          .parse(data)
          .flatMap((row) =>
            toMembership({
              tenantId: row.tenant_id,
              slug: row.slug,
              displayName: row.display_name,
              status: row.tenant_status,
              demo: row.is_demo,
              role: row.role,
              needsSecondFactor: row.needs_second_factor,
            }),
          );
      }
      if (!isMissingFunction(error)) {
        throw new Error(`Could not read memberships (${error.code ?? "unknown"})`);
      }

      // The web app was deployed before the migration of ADR-043: read them as before.
      // The explicit `user_id` filter matters because owners/admins also see their roster.
      const legacy = await client
        .from("memberships")
        .select("role, tenant:tenants!inner(id, slug, display_name, status, is_demo)")
        .eq("user_id", userId)
        .eq("status", "active");
      if (legacy.error) {
        throw new Error(`Could not read memberships (${legacy.error.code ?? "unknown"})`);
      }
      return z
        .array(legacyRowSchema)
        .parse(legacy.data)
        .flatMap((row) =>
          toMembership({
            tenantId: row.tenant.id,
            slug: row.tenant.slug,
            displayName: row.tenant.display_name,
            status: row.tenant.status,
            demo: row.tenant.is_demo,
            role: row.role,
            needsSecondFactor: false,
          }),
        );
    },
  };
}
