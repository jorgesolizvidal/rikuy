import { formatStorage, meter, type OperationsAlert, type OperationsSnapshot } from "@rikuy/core";
import Link from "next/link";

import { UsageBar } from "@/components/usage/usage-bar";

/**
 * «Estado de la plataforma» (ADR-035): what the free plans can run out of and the queue's
 * health, with the same alerts the daily email sends. Server component, no client code.
 */
export function OperationsSummary({
  snapshot,
  alerts,
}: {
  readonly snapshot: OperationsSnapshot;
  readonly alerts: readonly OperationsAlert[];
}) {
  const bar = (bytes: number, limit: number) =>
    meter({
      resource: "storage_bytes",
      limit,
      consumed: bytes,
      reserved: 0,
      periodStart: null,
      periodEnd: null,
    });
  return (
    <section aria-labelledby="estado" className="operations">
      <h2 id="estado">Estado de la plataforma</h2>
      {alerts.length === 0 ? (
        <p className="notice" role="status">
          Todo en orden. Cuando algo necesite una revisión, también te llegará un correo por la
          mañana.
        </p>
      ) : (
        <ul className="operations-alerts" aria-label="Avisos">
          {alerts.map((alert) => (
            <li key={`${alert.code}:${alert.message}`} data-level={alert.level}>
              <strong>{alert.level === "critical" ? "Urgente" : "Revisar"}:</strong> {alert.message}
            </li>
          ))}
        </ul>
      )}
      <ul className="usage-list">
        <li className="usage-card">
          <h3>Almacenamiento del proyecto</h3>
          <p className="field-hint">
            Fotos, panoramas y modelos de todos los municipios, con sus copias públicas.
          </p>
          <UsageBar
            meter={bar(snapshot.storage.bytes, snapshot.storage.limit)}
            label="Almacenamiento del proyecto"
          />
        </li>
        <li className="usage-card">
          <h3>Base de datos</h3>
          <p className="field-hint">Contenido, revisiones, auditoría y trabajos.</p>
          <UsageBar
            meter={bar(snapshot.database.bytes, snapshot.database.limit)}
            label="Base de datos"
          />
        </li>
        <li className="usage-card">
          <h3>Trabajos</h3>
          <p>
            {snapshot.jobs.failed24h === 0
              ? "Ninguno falló en las últimas 24 h."
              : snapshot.jobs.failed24h === 1
                ? "Uno falló en las últimas 24 h."
                : `${snapshot.jobs.failed24h} fallaron en las últimas 24 h.`}{" "}
            {snapshot.jobs.waitingSeconds > 60
              ? `Hay trabajo esperando desde hace ${Math.round(snapshot.jobs.waitingSeconds / 60)} min.`
              : "No hay trabajo esperando."}
          </p>
          <Link href="/plataforma/trabajos">Ver los trabajos</Link>
        </li>
        <li className="usage-card">
          <h3>Imágenes sin uso</h3>
          <p>
            {snapshot.unusedMedia.removed7d === 0
              ? "No se limpió ninguna en los últimos 7 días."
              : `${snapshot.unusedMedia.removed7d === 1 ? "1 limpiada" : `${snapshot.unusedMedia.removed7d} limpiadas`} en los últimos 7 días (${formatStorage(snapshot.unusedMedia.bytes7d)}).`}
          </p>
          <p className="field-hint">
            Cada noche se borran las fotos y logos que ningún destino, evento, tour ni marca usa
            desde hace más de 7 días. Los panoramas y modelos 3D no se tocan.
          </p>
        </li>
      </ul>
    </section>
  );
}
