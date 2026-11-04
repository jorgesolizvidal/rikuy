import {
  AI_PLATFORM_AUDIO_DAILY_LIMIT,
  AI_PLATFORM_DAILY_LIMIT,
  meter,
  QUOTA_DEFAULTS,
  USAGE_RESOURCES,
  type PlatformAiUsageRow,
  type PlatformUsageRow,
} from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { UsageBar } from "@/components/usage/usage-bar";
import {
  formatAmount,
  RESOURCE_INPUT_UNITS,
  RESOURCE_LABELS,
} from "@/components/usage/usage-format";
import { operatorContext } from "@/server/operator";

import { SignOutButton } from "../../sign-out-button";
import { QuotaForm } from "./quota-form";

export const metadata: Metadata = { title: "Cuotas por municipio" };

export default async function QuotasPage() {
  const { gate, session } = await operatorContext();
  if (gate.status === "denied") notFound();
  if (gate.status !== "granted") redirect("/plataforma");

  const [usage, ai, voice] = await Promise.all([
    session.platformUsage.list(),
    session.platformAiUsage.list(),
    session.platformAiUsage.listVoice(),
  ]);
  // AI (ADR-036) and dictation (ADR-041) have their own readings: one more resource each.
  const asRows = (
    rows: readonly PlatformAiUsageRow[] | null,
    resource: "ai_tokens" | "ai_audio_seconds",
  ): PlatformUsageRow[] =>
    (rows ?? []).map((row) => ({
      tenantId: row.tenantId,
      slug: row.slug,
      displayName: row.displayName,
      resource,
      limit: row.limit,
      isDefault: row.isDefault,
      reserved: row.reserved,
      consumed: row.consumed,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
    }));
  const rows: PlatformUsageRow[] = [
    ...usage,
    ...asRows(ai, "ai_tokens"),
    ...asRows(voice, "ai_audio_seconds"),
  ];
  const tenants = new Map<string, PlatformUsageRow[]>();
  for (const row of rows) tenants.set(row.tenantId, [...(tenants.get(row.tenantId) ?? []), row]);
  const total = rows
    .filter((row) => row.resource === "storage_bytes")
    .reduce((sum, row) => sum + row.consumed + row.reserved, 0);

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <header className="admin-header">
        <Link href="/plataforma" className="eyebrow">
          ← Plataforma
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Cuotas por municipio</h1>
        <p className="lead">
          Cuánto puede usar cada municipio. Por defecto:{" "}
          {formatAmount("storage_bytes", QUOTA_DEFAULTS.storage_bytes)} de almacenamiento y{" "}
          {formatAmount("media_compute_seconds", QUOTA_DEFAULTS.media_compute_seconds)} de
          procesamiento de medios por mes, {formatAmount("ai_tokens", QUOTA_DEFAULTS.ai_tokens)} de
          IA por día y {formatAmount("ai_audio_seconds", QUOTA_DEFAULTS.ai_audio_seconds)} de
          dictado por voz por día. Bajar un límite no borra nada: solo frena las subidas nuevas, las
          respuestas de la IA o el dictado. Cada cambio queda auditado.
        </p>
        <p className="field-hint">
          Almacenamiento usado entre todos: {formatAmount("storage_bytes", total)}. El plan gratuito
          de Supabase tiene 1 GB para todo el proyecto. La IA de todos los municipios junta tiene un
          tope de {formatAmount("ai_tokens", AI_PLATFORM_DAILY_LIMIT)} por día (el 90 % del plan
          gratuito de Groq), así que conviene que la suma de las cuotas de IA no lo pase mucho. El
          dictado de todos los municipios junto tiene un tope de{" "}
          {formatAmount("ai_audio_seconds", AI_PLATFORM_AUDIO_DAILY_LIMIT)} por día.
        </p>
      </div>

      <ul className="usage-list">
        {[...tenants.values()].map((tenantRows) => {
          const first = tenantRows[0];
          if (!first) return null;
          return (
            <li key={first.tenantId} className="usage-card">
              <h2>
                {first.displayName} <span className="cell-detail">({first.slug})</span>
              </h2>
              {USAGE_RESOURCES.map((resource) => {
                const row = tenantRows.find((item) => item.resource === resource);
                if (!row) return null;
                const unit = RESOURCE_INPUT_UNITS[resource];
                return (
                  <section
                    key={resource}
                    className="usage-resource"
                    aria-label={`${RESOURCE_LABELS[resource]} de ${first.displayName}`}
                  >
                    <h3>
                      {RESOURCE_LABELS[resource]}
                      {row.isDefault ? <span className="cell-detail"> · por defecto</span> : null}
                    </h3>
                    <UsageBar
                      meter={meter(row)}
                      label={`${RESOURCE_LABELS[resource]} de ${first.displayName}`}
                    />
                    <QuotaForm
                      tenantId={first.tenantId}
                      tenantName={first.displayName}
                      resource={resource}
                      resourceLabel={RESOURCE_LABELS[resource]}
                      unit={unit.label}
                      current={String(Math.round((row.limit / unit.factor) * 100) / 100)}
                    />
                  </section>
                );
              })}
            </li>
          );
        })}
      </ul>
    </main>
  );
}
