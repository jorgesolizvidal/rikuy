"use client";

/**
 * Inside a portal (its header and footer stay): a page the server could not build. The
 * reference code is the one the platform records with the error (ADR-044), so the team can
 * find it; it says nothing about the visitor.
 */
export default function PortalError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <div className="portal-page">
      <h1 className="portal-page-title">No pudimos cargar esta página</h1>
      <p className="portal-lead">Es un problema nuestro. Inténtalo de nuevo en unos segundos.</p>
      <p>
        <button type="button" className="portal-button" onClick={reset}>
          Volver a intentar
        </button>{" "}
        <a href="/">Ir al inicio</a>
      </p>
      {error.digest ? (
        <p className="portal-legal-note">
          Código de referencia: <code>{error.digest}</code>
        </p>
      ) : null}
    </div>
  );
}
