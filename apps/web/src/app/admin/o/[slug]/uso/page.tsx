import { loadAiUsage, loadUsage } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { UsageBar } from "@/components/usage/usage-bar";
import { RESOURCE_DETAILS, RESOURCE_LABELS } from "@/components/usage/usage-format";
import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";

export const metadata: Metadata = { title: "Uso del plan" };

interface UsagePageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function UsagePage({ params }: UsagePageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const [meters, ai] = await Promise.all([
    loadUsage(membership, session.usage),
    loadAiUsage(membership, session.aiUsage),
  ]);

  return (
    <main id="contenido" tabIndex={-1} className="shell">
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Uso del plan</h1>
        <p className="lead">
          Cuánto usa {membership.displayName} de lo que tiene asignado. Cuando algo llega a su
          límite, se rechazan las subidas nuevas (o el asistente avisa que no puede responder); no
          se borra nada de lo que ya está.
        </p>
      </div>

      <ul className="usage-list">
        {meters.map((meter) => (
          <li key={meter.resource} className="usage-card">
            <h2>{RESOURCE_LABELS[meter.resource]}</h2>
            <p className="field-hint">{RESOURCE_DETAILS[meter.resource]}</p>
            <UsageBar meter={meter} />
            {meter.resource === "media_compute_seconds" ? (
              <p className="field-hint">Se renueva el día 1 de cada mes.</p>
            ) : null}
            {meter.level === "full" ? (
              <p className="notice" role="status">
                Llegó a su límite: las subidas nuevas que lo necesiten se rechazan. Pide al equipo
                de la plataforma que lo amplíe.
              </p>
            ) : meter.level === "near" ? (
              <p className="notice" role="status">
                Ya usa más del 80 %. Si van a subir más, conviene pedir que lo amplíen.
              </p>
            ) : null}
          </li>
        ))}
        <li className="usage-card">
          <h2>{RESOURCE_LABELS.ai_tokens}</h2>
          <p className="field-hint">{RESOURCE_DETAILS.ai_tokens}</p>
          <UsageBar meter={ai.meter} />
          <p className="field-hint">
            Hoy: {ai.answeredToday === 1 ? "1 respuesta" : `${ai.answeredToday} respuestas`}
            {ai.refusedToday > 0
              ? ` y ${ai.refusedToday === 1 ? "1 pregunta" : `${ai.refusedToday} preguntas`} sin responder por un límite`
              : ""}
            . Se renueva cada día a medianoche.
          </p>
          {ai.meter.level === "full" ? (
            <p className="notice" role="status">
              Usó su IA de hoy: el asistente responde con un aviso y enlaces útiles hasta
              medianoche. El resto del portal funciona igual.
            </p>
          ) : ai.meter.level === "near" ? (
            <p className="notice" role="status">
              Ya usa más del 80 % de su IA de hoy.
            </p>
          ) : null}
        </li>
      </ul>
      <p className="field-hint">
        Lo «reservado» es una estimación de lo que están subiendo o procesando ahora; se ajusta a lo
        real cuando termina.
      </p>
    </main>
  );
}
