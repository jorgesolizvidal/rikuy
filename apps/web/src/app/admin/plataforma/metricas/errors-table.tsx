import type { RequestErrorRow } from "@rikuy/core";

import { formatWhen, SURFACE_LABELS } from "./format";

/**
 * The latest server errors, with what the operator needs to find one: its request ID
 * (X-Rikuy-Request-Id) and its reference code (the digest a visitor sees). A GET form
 * filters by either; the page reads it from the address.
 */
export function ErrorsTable({
  errors,
  search,
  action,
}: {
  readonly errors: readonly RequestErrorRow[];
  readonly search: string | null;
  readonly action: string;
}) {
  return (
    <>
      <form method="get" action={action} className="inline-form metrics-search" role="search">
        <label htmlFor="buscar">ID de petición o código de referencia</label>
        <input
          id="buscar"
          name="buscar"
          defaultValue={search ?? ""}
          maxLength={64}
          autoComplete="off"
        />
        <button type="submit" className="button button-quiet">
          Buscar
        </button>
        {search ? (
          <a href={action} className="button button-quiet">
            Ver todos
          </a>
        ) : null}
      </form>
      {errors.length === 0 ? (
        <p className="notice" role="status">
          {search ? "Ningún error con ese ID o código." : "Ningún error registrado en 30 días."}
        </p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Errores" tabIndex={0}>
          <table className="data-table">
            <caption className="visually-hidden">Últimos errores del servidor</caption>
            <thead>
              <tr>
                <th scope="col">Cuándo</th>
                <th scope="col">Dónde</th>
                <th scope="col">Error</th>
                <th scope="col">ID y código</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((error) => (
                <tr key={error.id}>
                  <td>{formatWhen(error.occurredAt)}</td>
                  <td>
                    {SURFACE_LABELS[error.surface]} · {error.method}
                    <span className="org-detail">
                      <code>{error.route}</code>
                    </span>
                  </td>
                  <td>
                    {error.kind}
                    {error.message ? <span className="org-detail">{error.message}</span> : null}
                  </td>
                  <td>
                    <code>{error.requestId}</code>
                    {error.digest ? (
                      <span className="org-detail">
                        Código <code>{error.digest}</code>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
