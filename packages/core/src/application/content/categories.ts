import type { MembershipRole, OrganizationMembership } from "../../contracts/organization";
import { slugify } from "../../domain/tenancy/slug";

/**
 * Categories of the municipality (C3 · Paso 3, ADR-062). Owners and admins define the list
 * for destinations and for events; a destination or an event picks one in its draft, so the
 * category is published with the rest. Removing a category archives it: nothing published
 * changes, the portal just stops showing it.
 */

export const CATEGORY_KINDS = ["destination", "event"] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

export const CATEGORY_LIMITS = { name: 40, perKind: 20 } as const;

export interface ContentCategory {
  readonly id: string;
  readonly kind: CategoryKind;
  readonly name: string;
  readonly position: number;
  /** Items whose working revision uses it. */
  readonly used: number;
}

/** One line of the list being saved: an id keeps (and renames) a category; none is new. */
export interface CategoryDraft {
  readonly id?: string;
  readonly name: string;
}

export type SaveCategoriesOutcome =
  | { readonly status: "saved"; readonly categories: readonly ContentCategory[] }
  | { readonly status: "forbidden" }
  | { readonly status: "duplicate"; readonly name: string }
  | { readonly status: "invalid"; readonly index?: number };

/** With the signed-in user's session (the RPCs check the role again). */
export interface CategoryRepository {
  list(tenantId: string): Promise<ContentCategory[]>;
  save(
    tenantId: string,
    kind: CategoryKind,
    categories: readonly CategoryDraft[],
  ): Promise<SaveCategoriesOutcome>;
}

export function canManageCategories(role: MembershipRole): boolean {
  return role === "owner" || role === "admin";
}

export interface CategoriesView {
  readonly destination: readonly ContentCategory[];
  readonly event: readonly ContentCategory[];
  readonly canManage: boolean;
}

/** The categories of each kind, in order. Any member. */
export async function loadCategories(
  membership: OrganizationMembership,
  deps: { readonly categories: CategoryRepository },
): Promise<CategoriesView> {
  const all = await deps.categories.list(membership.tenantId);
  const ordered = [...all].sort((a, b) => a.position - b.position);
  return {
    destination: ordered.filter((category) => category.kind === "destination"),
    event: ordered.filter((category) => category.kind === "event"),
    canManage: canManageCategories(membership.role),
  };
}

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The list as the base will receive it, or the line that is wrong. */
export function parseCategoryList(
  input: readonly CategoryDraft[],
):
  | { readonly ok: true; readonly list: readonly CategoryDraft[] }
  | { readonly ok: false; readonly outcome: SaveCategoriesOutcome } {
  if (input.length > CATEGORY_LIMITS.perKind) {
    return { ok: false, outcome: { status: "invalid" } };
  }
  const seen = new Set<string>();
  const ids = new Set<string>();
  const list: CategoryDraft[] = [];
  for (const [index, line] of input.entries()) {
    const name = line.name.replace(/\s+/gu, " ").trim();
    if (
      name === "" ||
      Array.from(name).length > CATEGORY_LIMITS.name ||
      !NO_CONTROL_CHARACTERS.test(name) ||
      (line.id !== undefined && (!UUID.test(line.id) || ids.has(line.id)))
    ) {
      return { ok: false, outcome: { status: "invalid", index } };
    }
    const key = name.toLocaleLowerCase("es");
    if (seen.has(key)) return { ok: false, outcome: { status: "duplicate", name } };
    seen.add(key);
    if (line.id !== undefined) ids.add(line.id);
    list.push(line.id === undefined ? { name } : { id: line.id, name });
  }
  return { ok: true, list };
}

/** Replaces the list of one kind, in the given order (owners and admins). */
export async function saveCategories(
  membership: OrganizationMembership,
  kind: CategoryKind,
  input: readonly CategoryDraft[],
  deps: { readonly categories: CategoryRepository },
): Promise<SaveCategoriesOutcome> {
  if (!canManageCategories(membership.role)) return { status: "forbidden" };
  const parsed = parseCategoryList(input);
  if (!parsed.ok) return parsed.outcome;
  return deps.categories.save(membership.tenantId, kind, parsed.list);
}

/** A category in the portal's index: what the filters show. */
export interface PortalCategory {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  /** For the address of the filter (`?categoria=…`). */
  readonly slug: string;
}

/** One published destination or event in the portal's index. */
export interface PortalIndexEntry {
  readonly kind: CategoryKind;
  readonly contentId: string;
  readonly slug: string;
  readonly category: {
    readonly id: string;
    readonly name: string;
    readonly position: number;
  } | null;
}

/** Anonymous read of the portal's index (`portal_content_index`). */
export interface PublishedContentIndexReader {
  index(tenantId: string): Promise<PortalIndexEntry[]>;
}

/**
 * The categories in use among these items of one kind, in the municipality's order, with
 * a unique address each (two names that slugify alike get a number).
 */
export function categoriesInUse(
  entries: readonly PortalIndexEntry[],
  kind: CategoryKind,
  slugs?: ReadonlySet<string>,
): readonly PortalCategory[] {
  const byId = new Map<string, { id: string; name: string; position: number }>();
  for (const entry of entries) {
    if (entry.kind !== kind || entry.category === null) continue;
    if (slugs !== undefined && !slugs.has(entry.slug)) continue;
    byId.set(entry.category.id, entry.category);
  }
  const used = new Set<string>();
  return [...byId.values()]
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, "es"))
    .map((category) => {
      const base = slugify(category.name, 40) || "categoria";
      let slug = base;
      for (let n = 2; used.has(slug); n += 1) slug = `${base}-${String(n)}`;
      used.add(slug);
      return { ...category, slug };
    });
}

/** The category of each published item of one kind, by its address. */
export function categoryBySlug(
  entries: readonly PortalIndexEntry[],
  kind: CategoryKind,
): ReadonlyMap<string, { readonly id: string; readonly name: string }> {
  return new Map(
    entries.flatMap((entry) =>
      entry.kind === kind && entry.category !== null
        ? [[entry.slug, { id: entry.category.id, name: entry.category.name }] as const]
        : [],
    ),
  );
}
