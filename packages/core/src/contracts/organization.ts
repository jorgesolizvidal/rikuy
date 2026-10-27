import { z } from "zod";

export const membershipRoleSchema = z.enum(["owner", "admin", "editor", "analyst"]);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

/** An organization (tenant) the current user can act in, with their current role. */
export const organizationMembershipSchema = z.object({
  tenantId: z.uuid(),
  slug: z.string().min(1),
  displayName: z.string().min(1),
  role: membershipRoleSchema,
  /** Owners can prepare a provisioning tenant before it goes live; suspended ones are hidden. */
  tenantStatus: z.enum(["provisioning", "active"]),
  /** A commercial demo (ADR-034): offers the sample content. Absent means a real one. */
  demo: z.boolean().optional(),
});
export type OrganizationMembership = z.infer<typeof organizationMembershipSchema>;

/** The authenticated person behind a request. Identity only; never permissions. */
export interface Actor {
  readonly userId: string;
  readonly email: string | null;
}

export const ROLE_LABELS: Readonly<Record<MembershipRole, string>> = {
  owner: "Propietario",
  admin: "Administrador",
  editor: "Editor",
  analyst: "Analista",
};
