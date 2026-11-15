"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { currentNavHref, type PanelNavGroup } from "@/lib/panel-nav-current";

import { SignOutButton } from "../../sign-out-button";

/**
 * The municipality's menu (ADR-066). On a PC it stays on the left, with the section of the
 * page marked; on a phone it opens with «Menú» and closes on Escape (focus back on the button)
 * or when a page is chosen.
 */
export function PanelNav({
  name,
  role,
  groups,
}: {
  readonly name: string;
  readonly role: string;
  readonly groups: readonly PanelNavGroup[];
}) {
  const pathname = usePathname();
  const current = currentNavHref(groups, pathname);
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const menuId = `${id}-menu`;

  // A page was chosen: the phone's menu closes.
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <aside className="panel-nav" aria-label="Menú del municipio">
      <div className="panel-nav-head">
        <p className="panel-nav-org">
          <span className="panel-nav-name">{name}</span>
          <span className="panel-nav-role">{role}</span>
        </p>
        <button
          ref={toggle}
          type="button"
          className="panel-nav-toggle"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((value) => !value)}
        >
          <MenuIcon open={open} />
          Menú
        </button>
      </div>
      <div id={menuId} className="panel-nav-menu" data-open={open ? "true" : undefined}>
        <nav aria-label="Secciones">
          {groups.map((group, index) => {
            const titleId = `${id}-group-${index}`;
            return (
              <div key={group.title ?? "inicio"} className="panel-nav-group">
                {group.title ? (
                  <p className="panel-nav-title" id={titleId}>
                    {group.title}
                  </p>
                ) : null}
                <ul aria-labelledby={group.title ? titleId : undefined}>
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        // Every page of the panel is dynamic: prefetching the whole menu would
                        // render ~16 pages on the server on every visit and every refresh.
                        prefetch={false}
                        className="panel-nav-link"
                        aria-current={item.href === current ? "page" : undefined}
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="panel-nav-foot">
          <Link href="/" prefetch={false} className="panel-nav-link panel-nav-quiet">
            Tus municipios
          </Link>
          <SignOutButton />
        </div>
      </div>
    </aside>
  );
}

function MenuIcon({ open }: { readonly open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        d={open ? "M6 6l12 12M18 6 6 18" : "M4 7h16M4 12h16M4 17h16"}
      />
    </svg>
  );
}
