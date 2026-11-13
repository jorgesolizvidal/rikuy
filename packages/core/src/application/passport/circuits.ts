import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import {
  CIRCUIT_LIMITS,
  isCircuitSlug,
  parseCircuitDraft,
  type CircuitField,
} from "../../domain/passport/circuits";
import { slugify } from "../../domain/tenancy/slug";
import type { ContentRepository, PublishedImage } from "../content/ports";

/**
 * The circuits of the tourist passport (C2 · Paso 1, ADR-056). Editors build drafts; owners
 * and admins publish, withdraw and change what is published (like destinations). The portal
 * shows the published ones with the stops whose destination is published now.
 */

export interface CircuitStop {
  readonly contentId: string;
  readonly position: number;
  readonly slug: string;
  readonly title: string;
  /** Its destination is published now (only those count and reach the portal). */
  readonly published: boolean;
}

export interface PassportCircuit {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly reward: string;
  readonly status: "draft" | "published";
  readonly editNo: number;
  /** First publication; a circuit that visitors saw is withdrawn, never deleted. */
  readonly publishedAt: string | null;
  readonly updatedAt: string;
  readonly stops: readonly CircuitStop[];
}

export type CircuitWriteOutcome =
  | { readonly status: "saved"; readonly editNo: number }
  | { readonly status: "stale" }
  | { readonly status: "forbidden" }
  | { readonly status: "not_found" }
  | { readonly status: "incomplete" }
  | { readonly status: "invalid"; readonly errors?: Partial<Record<CircuitField, string>> };

export type CreateCircuitOutcome =
  | { readonly status: "created"; readonly circuitId: string }
  | { readonly status: "taken" }
  | { readonly status: "forbidden" }
  | { readonly status: "invalid"; readonly errors?: Partial<Record<"slug" | "name", string>> };

export type DeleteCircuitOutcome =
  | { readonly status: "deleted" }
  | { readonly status: "stale" }
  | { readonly status: "forbidden" }
  | { readonly status: "not_found" }
  | { readonly status: "published" };

/** With the signed-in user's session (the RPCs check the role again). */
export interface PassportRepository {
  list(tenantId: string): Promise<PassportCircuit[]>;
  create(tenantId: string, slug: string, name: string): Promise<CreateCircuitOutcome>;
  save(
    tenantId: string,
    circuitId: string,
    editNo: number,
    draft: {
      readonly name: string;
      readonly summary: string;
      readonly reward: string;
      readonly stops: readonly string[];
    },
  ): Promise<CircuitWriteOutcome>;
  publish(tenantId: string, circuitId: string, editNo: number): Promise<CircuitWriteOutcome>;
  withdraw(tenantId: string, circuitId: string, editNo: number): Promise<CircuitWriteOutcome>;
  remove(tenantId: string, circuitId: string, editNo: number): Promise<DeleteCircuitOutcome>;
}

export function canEditCircuits(role: MembershipRole): boolean {
  return role === "owner" || role === "admin" || role === "editor";
}

export function canPublishCircuits(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

/** Who can change this circuit: anyone who edits a draft; only publishers a published one. */
export function canChangeCircuit(role: MembershipRole, circuit: PassportCircuit): boolean {
  return circuit.status === "published" ? canPublishCircuits(role) : canEditCircuits(role);
}

export function suggestCircuitSlug(name: string): string {
  return slugify(name, CIRCUIT_LIMITS.slug);
}

export interface PassportDestinationOption {
  readonly contentId: string;
  readonly title: string;
  readonly published: boolean;
}

export interface PassportView {
  readonly circuits: readonly PassportCircuit[];
  /** The municipality's destinations, to add as stops (published first, then by name). */
  readonly destinations: readonly PassportDestinationOption[];
  readonly canEdit: boolean;
  readonly canPublish: boolean;
}

/** Every circuit and the destinations that can be stops. Any member. */
export async function loadPassport(
  membership: OrganizationMembership,
  deps: { readonly passport: PassportRepository; readonly content: ContentRepository },
): Promise<PassportView> {
  const [circuits, destinations] = await Promise.all([
    deps.passport.list(membership.tenantId),
    deps.content.listDestinations(membership.tenantId),
  ]);
  return {
    circuits,
    destinations: destinations
      .map((destination) => ({
        contentId: destination.contentId,
        title: destination.title,
        published: destination.publishedAt !== null,
      }))
      .sort(
        (a, b) => Number(b.published) - Number(a.published) || a.title.localeCompare(b.title, "es"),
      ),
    canEdit: canEditCircuits(membership.role),
    canPublish: canPublishCircuits(membership.role),
  };
}

/** «Nuevo circuito»: editors and above. */
export async function createCircuit(
  membership: OrganizationMembership,
  passport: PassportRepository,
  input: { readonly slug: unknown; readonly name: unknown },
): Promise<CreateCircuitOutcome> {
  if (!canEditCircuits(membership.role)) return { status: "forbidden" };
  const parsed = parseCircuitDraft({ name: input.name, summary: "", reward: "", stops: [] });
  const errors: Partial<Record<"slug" | "name", string>> = {};
  if (!parsed.ok && parsed.errors.name) errors.name = parsed.errors.name;
  if (!isCircuitSlug(input.slug)) {
    errors.slug = "La dirección lleva solo letras minúsculas sin tildes, números y guiones.";
  }
  if (!parsed.ok || Object.keys(errors).length > 0) return { status: "invalid", errors };
  return passport.create(membership.tenantId, input.slug as string, parsed.value.name);
}

/** «Guardar»: a draft by editors and above; a published circuit only by owners and admins. */
export async function saveCircuit(
  membership: OrganizationMembership,
  passport: PassportRepository,
  input: {
    readonly circuitId: string;
    readonly editNo: number;
    readonly name: unknown;
    readonly summary: unknown;
    readonly reward: unknown;
    readonly stops: unknown;
  },
): Promise<CircuitWriteOutcome> {
  if (!canEditCircuits(membership.role)) return { status: "forbidden" };
  const parsed = parseCircuitDraft(input);
  if (!parsed.ok) return { status: "invalid", errors: parsed.errors };
  return passport.save(membership.tenantId, input.circuitId, input.editNo, parsed.value);
}

export async function publishCircuit(
  membership: OrganizationMembership,
  passport: PassportRepository,
  circuitId: string,
  editNo: number,
): Promise<CircuitWriteOutcome> {
  if (!canPublishCircuits(membership.role)) return { status: "forbidden" };
  return passport.publish(membership.tenantId, circuitId, editNo);
}

export async function withdrawCircuit(
  membership: OrganizationMembership,
  passport: PassportRepository,
  circuitId: string,
  editNo: number,
): Promise<CircuitWriteOutcome> {
  if (!canPublishCircuits(membership.role)) return { status: "forbidden" };
  return passport.withdraw(membership.tenantId, circuitId, editNo);
}

/** Only a circuit that was never published (owners and admins). */
export async function deleteCircuit(
  membership: OrganizationMembership,
  passport: PassportRepository,
  circuitId: string,
  editNo: number,
): Promise<DeleteCircuitOutcome> {
  if (!canPublishCircuits(membership.role)) return { status: "forbidden" };
  return passport.remove(membership.tenantId, circuitId, editNo);
}

// ── The portal ──────────────────────────────────────────────────────────────

export interface PortalCircuitStop {
  /** The place (content id) its stamps are kept by; null until the stamps migration runs. */
  readonly id: string | null;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly cover: PublishedImage | null;
}

export interface PortalCircuit {
  readonly slug: string;
  readonly name: string;
  readonly summary: string;
  readonly reward: string;
  readonly publishedAt: string;
  /** At least two, in the suggested order. */
  readonly stops: readonly PortalCircuitStop[];
}

/** Anonymous: the published circuits of an online municipality. */
export interface PublishedPassportReader {
  circuits(tenantId: string): Promise<PortalCircuit[]>;
}
