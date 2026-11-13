import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalView } from "@/server/portal-view";

import "../passport.css";
import "./redeem.css";
import { RedeemForm } from "./redeem-form";

/**
 * «Canjear un premio» (ADR-058): the page the shop opens to redeem a passport's voucher, with
 * the code the visitor shows and the shop's key. Not linked from the portal, never indexed.
 */

interface RedeemPageProps {
  readonly params: Promise<{ host: string }>;
}

export const metadata: Metadata = {
  title: "Canjear un premio",
  robots: { index: false, follow: false },
};

export default async function RedeemPage({ params }: RedeemPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  return (
    <div className="portal-page redeem-page">
      <h1 className="portal-page-title">Canjear un premio</h1>
      <p className="portal-lead">
        Para el local que entrega el premio de un circuito del pasaporte de{" "}
        {view.resolved.presentation.identity.siteName}. Escribe el código que te muestra el
        visitante y la clave del local que te dio el municipio.
      </p>
      <RedeemForm />
    </div>
  );
}
