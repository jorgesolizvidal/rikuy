"use client";

import type { BottomBarItem, BottomBarKey } from "@rikuy/core";
import { useEffect, useId, useRef, useState } from "react";

/**
 * The phone's bottom bar (ADR-062): the sections the municipality has, by its modules (no
 * configuration). Fixed at the foot of the screen, so it never moves the page; the current
 * section is marked with `aria-current`. Hidden on wide screens (the header has the links)
 * and on the 360° tour pages, which use the whole screen.
 */

const ICONS: Readonly<Record<BottomBarKey | "more", string>> = {
  home: "M4 11.5 12 5l8 6.5V20h-5.5v-5h-5v5H4z",
  destinations:
    "M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Zm0-8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
  agenda: "M5 6h14v14H5zM5 10h14M9 4v4M15 4v4",
  passport:
    "M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm5 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM9 17h6",
  map: "m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14",
  tours: "M3 12c0-2.2 4-4 9-4s9 1.8 9 4-4 4-9 4M8.5 15.6 12 16l-2.6 2.6M12 8V4",
  more: "M5 12h.01M12 12h.01M19 12h.01",
};

export interface BottomBarLink extends BottomBarItem {
  readonly href: string;
}

function Icon({ name }: { readonly name: BottomBarKey | "more" }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" focusable="false">
      <path
        d={ICONS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth={name === "more" ? 3.5 : 1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function isCurrent(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomBar({
  items,
  more,
}: {
  readonly items: readonly BottomBarLink[];
  readonly more: readonly BottomBarLink[];
}) {
  // The visible address, read in the browser: the server renders the portal under an
  // internal path, and the bar is the same for every page (cached with the layout).
  const [pathname, setPathname] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the address exists only in the browser
    setPathname(window.location.pathname);
  }, []);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const moreCurrent = more.some((item) => isCurrent(pathname, item.href));

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector("a")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <nav className="portal-bottom-bar" aria-label="Secciones">
      <ul>
        {items.map((item) => (
          <li key={item.key}>
            <a href={item.href} aria-current={isCurrent(pathname, item.href) ? "page" : undefined}>
              <Icon name={item.key} />
              <span>{item.label}</span>
            </a>
          </li>
        ))}
        {more.length > 0 ? (
          <li className="portal-bottom-more">
            <button
              ref={button}
              type="button"
              aria-expanded={open}
              aria-controls={menuId}
              data-current={moreCurrent ? "" : undefined}
              onClick={() => setOpen((value) => !value)}
            >
              <Icon name="more" />
              <span>Más</span>
            </button>
            <ul id={menuId} ref={menu} hidden={!open}>
              {more.map((item) => (
                <li key={item.key}>
                  <a
                    href={item.href}
                    aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                  >
                    <Icon name={item.key} />
                    <span>{item.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
