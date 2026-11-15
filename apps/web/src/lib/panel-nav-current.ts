/**
 * The menu's types and which item a page belongs to, without `@rikuy/core`: the menu is a
 * client component and gets its items from the server (ADR-066).
 */

export interface PanelNavItem {
  readonly href: string;
  readonly label: string;
}

export interface PanelNavGroup {
  /** Null for the first group (the municipality's home). */
  readonly title: string | null;
  readonly items: readonly PanelNavItem[];
}

/**
 * The item a page belongs to: its own address or one under it (a destination's editor is under
 * «Destinos»); the municipality's home only for itself.
 */
export function currentNavHref(groups: readonly PanelNavGroup[], pathname: string): string | null {
  const path = pathname.replace(/\/+$/u, "");
  let best: string | null = null;
  for (const item of groups.flatMap((group) => group.items)) {
    const exact = path === item.href;
    const under = path.startsWith(`${item.href}/`) && item !== groups[0]?.items[0];
    if ((exact || under) && (best === null || item.href.length > best.length)) best = item.href;
  }
  return best;
}
