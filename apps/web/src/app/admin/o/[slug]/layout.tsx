import { ROLE_LABELS } from "@rikuy/core";
import type { ReactNode } from "react";

import { panelNav } from "@/lib/panel-nav";
import { requireOrganization } from "@/server/organization";

import { PanelNav } from "./panel-nav";

interface OrganizationLayoutProps {
  readonly children: ReactNode;
  readonly params: Promise<{ slug: string }>;
}

/**
 * Every page of a municipality's panel with its menu (C3 · Paso 7, ADR-066): on a PC a column
 * on the left, on a phone behind «Menú». The membership is read once per request
 * (`requireOrganization` is cached) and the pages check their own module and role again.
 */
export default async function OrganizationLayout({ children, params }: OrganizationLayoutProps) {
  const membership = await requireOrganization((await params).slug);
  return (
    <div className="panel-frame">
      <PanelNav
        name={membership.displayName}
        role={ROLE_LABELS[membership.role]}
        groups={panelNav(membership)}
      />
      <div className="panel-main">{children}</div>
    </div>
  );
}
