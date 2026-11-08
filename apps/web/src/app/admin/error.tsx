"use client";

/**
 * A panel page the server could not build. The reference code is the one recorded with the
 * error (ADR-044): the operator finds it in «Métricas por municipio».
 */
export default function AdminError({
  error,
  reset,
}: {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}) {
  return (
    <main id="contenido" tabIndex={-1} className="shell shell-narrow">
      <h1 className="title title-sm">No pudimos cargar esta página</h1>
      <p className="lead">Inténtalo de nuevo en unos segundos.</p>
      <p>
        <button type="button" className="button" onClick={reset}>
          Volver a intentar
        </button>{" "}
        <a href="/">Ir a tus municipios</a>
      </p>
      {error.digest ? (
        <p className="field-hint">
          Si vuelve a pasar, comparte este código de referencia con el equipo de Rikuy:{" "}
          <code>{error.digest}</code>
        </p>
      ) : null}
    </main>
  );
}
