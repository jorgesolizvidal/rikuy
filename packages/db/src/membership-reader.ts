import type { MembershipReader, OrganizationMembership } from "@rikuy/core";
import { z } from "zod";

import type { SessionClient } from "./session-client";

const rowSchema = z.object({
  role: z.enum(["owner", "admin", "editor", "analyst"]),
  tenant: z.object({
    id: z.uuid(),
    slug: z.string(),
    display_name: z.string(),
    status: z.enum(["provisioning", "active", "suspended"]),
  }),
});

/**
 * Reads memberships with the user's own JWT: RLS decides what is visible. The explicit
 * `user_id` filter matters because owners/admins can also see their tenant's roster.
 */
export function createMembershipReader(client: SessionClient): MembershipReader {
  return {
    async listActiveMemberships(userId): Promise<OrganizationMembership[]> {
      const { data, error } = await client
        .from("memberships")
        .select("role, tenant:tenants!inner(id, slug, display_name, status)")
        .eq("user_id", userId)
        .eq("status", "active");

      if (error) throw new Error(`Could not read memberships (${error.code ?? "unknown"})`);

      return z
        .array(rowSchema)
        .parse(data)
        .filter((row) => row.tenant.status === "active")
        .map((row) => ({
          tenantId: row.tenant.id,
          slug: row.tenant.slug,
          displayName: row.tenant.display_name,
          role: row.role,
        }));
    },
  };
}
