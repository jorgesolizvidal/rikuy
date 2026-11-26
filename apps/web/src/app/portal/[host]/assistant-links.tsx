"use client";

import { createContext, useContext, type AnchorHTMLAttributes } from "react";

/**
 * Where the assistant is shown (ADR-071): the portal's floating button, its own page (a QR on a
 * sign) or a frame inside the municipality's website. It decides how its links open:
 *
 * - on the portal, as always;
 * - on its own page, what leaves the portal opens in another tab (the conversation stays);
 * - inside the website's frame, a page of that website replaces the website's page (`_top`,
 *   never inside the small frame), and a page of the portal opens in another tab.
 */
export type AssistantMode = "launcher" | "page" | "embed";

export const AssistantModeContext = createContext<AssistantMode>("launcher");

type LinkProps = Pick<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target" | "rel">;

export function linkProps(href: string, mode: AssistantMode): LinkProps {
  if (mode === "launcher" || typeof window === "undefined") return { href };
  let url: URL;
  try {
    url = new URL(href, window.location.origin);
  } catch {
    return { href };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { href };
  const own = url.origin === window.location.origin;
  if (mode === "embed") {
    return own
      ? { href: url.href, target: "_blank", rel: "noopener" }
      : { href: url.href, target: "_top" };
  }
  return own ? { href } : { href: url.href, target: "_blank", rel: "noopener noreferrer" };
}

/** The attributes of one of the assistant's links where it is shown. */
export function useLinkProps(): (href: string) => LinkProps {
  const mode = useContext(AssistantModeContext);
  return (href) => linkProps(href, mode);
}

/** Where an item of an answer leads (ADR-071): its own `link` when the server set one. */
export function targetOf(item: {
  readonly href: string | null;
  readonly link?: string | null;
}): string | null {
  return item.link === undefined ? item.href : item.link;
}
