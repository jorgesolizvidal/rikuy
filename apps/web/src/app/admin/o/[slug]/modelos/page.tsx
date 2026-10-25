import { loadModels } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import { AutoRefresh } from "../panoramas/auto-refresh";
import {
  formatCount,
  formatDelta,
  formatMegabytes,
  MODEL_STATUS,
  pendingDetail,
  texturesSummary,
  worstColorDrift,
} from "./labels";
import { ModelPreview } from "./model-preview";
import { ModelUpload } from "./model-upload";

export const metadata: Metadata = { title: "Modelos 3D" };

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
  timeZone: "America/La_Paz",
});

interface ModelsPageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function ModelsPage({ params }: ModelsPageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const { cards, canUpload } = await loadModels(membership, {
    models: session.models,
    media: session.media,
  });
  const processing = cards.some((card) => card.status === "processing");

  return (
    <main id="contenido" tabIndex={-1} className="shell shell-wide">
      <AutoRefresh active={processing} />
      <header className="admin-header">
        <Link href={`/o/${membership.slug}`} className="eyebrow">
          ← {membership.displayName}
        </Link>
        <SignOutButton />
      </header>
      <div className="branding-heading">
        <h1 className="title title-sm">Modelos 3D</h1>
        <p className="lead">
          Objetos en 3D para los recorridos virtuales. Son privados: los visitantes los verán cuando
          se publique un recorrido que los use, y solo se descargan si tocan el objeto.
        </p>
      </div>

      {canUpload ? (
        <section aria-labelledby="nuevo-modelo" className="members-invite">
          <h2 id="nuevo-modelo">Nuevo modelo</h2>
          <ModelUpload slug={membership.slug} />
        </section>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver los modelos, pero no subirlos.
        </p>
      )}

      {cards.length === 0 ? (
        <p className="notice">Todavía no hay modelos.</p>
      ) : (
        <ul className="panorama-list" aria-label={`Modelos de ${membership.displayName}`}>
          {cards.map((card) => {
            const manifest = card.manifest;
            const label = `subido el ${DATE.format(new Date(card.createdAt))}`;
            const drift = worstColorDrift(card);
            return (
              <li key={card.versionId} className="panorama-card model-card">
                {card.status === "ready" && card.modelUrl ? (
                  <ModelPreview
                    slug={membership.slug}
                    versionId={card.versionId}
                    modelUrl={card.modelUrl}
                    posterUrl={card.posterUrl}
                    posterSize={
                      manifest?.poster
                        ? { width: manifest.poster.width, height: manifest.poster.height }
                        : null
                    }
                    label={label}
                    canEdit={canUpload}
                  />
                ) : (
                  <div className="panorama-thumb model-thumb" data-empty="true">
                    <span>{MODEL_STATUS[card.status]}</span>
                  </div>
                )}
                <div className="panorama-info">
                  <h2 className="model-title">Modelo {label}</h2>
                  <p>
                    <span className="status-pill" data-status={card.status}>
                      {MODEL_STATUS[card.status]}
                    </span>{" "}
                    {manifest?.weight === "heavy" ? (
                      <span className="status-pill" data-status="heavy">
                        Pesado para celulares
                      </span>
                    ) : null}
                  </p>
                  {manifest ? (
                    <>
                      <p className="cell-detail">
                        {formatMegabytes(manifest.source.bytes)} →{" "}
                        {formatMegabytes(manifest.model.bytes)} optimizado ·{" "}
                        {formatCount(manifest.model.triangles)} triángulos · {texturesSummary(card)}
                      </p>
                      <p className="field-hint">
                        {drift === null
                          ? "Colores verificados: materiales sin cambios."
                          : `Colores verificados: materiales sin cambios y una diferencia media de ΔE ${formatDelta(drift)} como máximo (imperceptible bajo 2,3).`}
                      </p>
                      {manifest.weight === "heavy" ? (
                        <p className="field-hint">
                          Pasa de 5 MB: funciona, pero tarda en abrir con datos móviles. Si puedes,
                          reduce las texturas.
                        </p>
                      ) : null}
                      {manifest.colors.suspects.length > 0 ? (
                        <div className="model-suspects" role="note">
                          <p>
                            <strong>Revisa sus colores en el programa 3D:</strong>
                          </p>
                          <ul>
                            {manifest.colors.suspects.map((suspect) => (
                              <li key={`${suspect.material}/${suspect.texture}`}>
                                El material «{suspect.material}» usa como color la imagen «
                                {suspect.texture}», que otro material usa como metal o rugosidad.
                                Probablemente no es su color.
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <p className="cell-detail">{formatMegabytes(card.declaredBytes)}</p>
                      <p className={card.status === "rejected" ? "field-error" : "field-hint"}>
                        {pendingDetail(card)}
                      </p>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {processing ? (
        <p className="field-hint" aria-live="polite">
          Esta lista se actualiza sola mientras haya modelos en proceso.
        </p>
      ) : null}
    </main>
  );
}
