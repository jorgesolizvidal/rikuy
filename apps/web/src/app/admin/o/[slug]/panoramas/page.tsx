import { loadPanoramas } from "@rikuy/core";
import type { Metadata } from "next";
import Link from "next/link";

import { adminSession } from "@/server/admin-session";
import { requireOrganization } from "@/server/organization";

import { SignOutButton } from "../../../sign-out-button";
import { AutoRefresh } from "./auto-refresh";
import { formatMegabytes, PANORAMA_STATUS, panoramaDetail } from "./labels";
import { MediaAssetActions } from "./media-asset-actions";
import { MediaAssetUses } from "./media-asset-uses";
import { PanoramaUpload } from "./panorama-upload";

export const metadata: Metadata = { title: "Panoramas 360°" };

interface PanoramasPageProps {
  readonly params: Promise<{ slug: string }>;
}

export default async function PanoramasPage({ params }: PanoramasPageProps) {
  const membership = await requireOrganization((await params).slug);
  const session = await adminSession();
  const { cards, assets, canUpload, canDelete } = await loadPanoramas(membership, {
    panoramas: session.panoramas,
    media: session.media,
    library: session.library,
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
        <h1 className="title title-sm">Panoramas 360°</h1>
        <p className="lead">
          Fotos 360° para los recorridos virtuales. Son privadas: los visitantes las verán cuando se
          publique un recorrido que las use.
        </p>
      </div>

      {canUpload ? (
        <section aria-labelledby="nuevo-panorama" className="members-invite">
          <h2 id="nuevo-panorama">Nuevo panorama</h2>
          <PanoramaUpload slug={membership.slug} />
        </section>
      ) : (
        <p className="notice" role="status">
          Tu rol puede ver los panoramas, pero no subirlos.
        </p>
      )}

      {assets.length === 0 ? (
        <p className="notice">Todavía no hay panoramas.</p>
      ) : (
        <ul className="panorama-list" aria-label={`Panoramas de ${membership.displayName}`}>
          {assets.map(
            ({ assetId, current: card, replacement, tours, outdatedTours, deletable }) => (
              <li key={assetId} className="panorama-card" data-asset={assetId}>
                <div className="panorama-thumb" data-empty={card.previewUrl === null}>
                  {card.previewUrl ? (
                    // Short-lived signed URL from Storage: next/image would cache it past expiry.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={card.previewUrl}
                      alt="Vista previa del panorama"
                      width={card.manifest?.preview.width}
                      height={card.manifest?.preview.height}
                      loading="lazy"
                    />
                  ) : (
                    <span>
                      {card.status === "ready" ? "Sin vista previa" : PANORAMA_STATUS[card.status]}
                    </span>
                  )}
                </div>
                <div className="panorama-info">
                  <p>
                    <span className="status-pill" data-status={card.status}>
                      {PANORAMA_STATUS[card.status]}
                    </span>{" "}
                    <span className="cell-detail">
                      {card.version > 1 ? `Versión ${card.version} · ` : ""}
                      {card.width && card.height ? `${card.width} × ${card.height} px · ` : ""}
                      {formatMegabytes(card.declaredBytes)}
                    </span>
                  </p>
                  <p className={card.status === "rejected" ? "field-error" : "field-hint"}>
                    {panoramaDetail(card)}
                  </p>
                  {card.imageUrl ? (
                    <a href={card.imageUrl} target="_blank" rel="noopener noreferrer">
                      Ver la imagen completa
                      <span className="visually-hidden"> (pestaña nueva)</span>
                    </a>
                  ) : null}
                  {replacement ? (
                    <p className={replacement.status === "rejected" ? "field-error" : "field-hint"}>
                      Versión nueva ({PANORAMA_STATUS[replacement.status].toLowerCase()}):{" "}
                      {panoramaDetail(replacement)}
                    </p>
                  ) : null}
                  <MediaAssetUses slug={membership.slug} tours={tours} noun="este panorama" />
                  <MediaAssetActions
                    slug={membership.slug}
                    kind="panorama"
                    assetId={assetId}
                    readyVersionId={card.status === "ready" ? card.versionId : null}
                    outdatedTours={outdatedTours}
                    deletable={deletable}
                    replacing={
                      replacement?.status === "uploading" || replacement?.status === "processing"
                    }
                    processing={
                      card.status === "processing" || replacement?.status === "processing"
                    }
                    canReplace={canUpload}
                    canDelete={canDelete}
                  />
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {processing ? (
        <p className="field-hint" aria-live="polite">
          Esta lista se actualiza sola mientras haya panoramas en proceso.
        </p>
      ) : null}
    </main>
  );
}
