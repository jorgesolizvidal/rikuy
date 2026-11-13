import { formatShortDate, type PassportSummary, type PassportTotal } from "@rikuy/core";
import Link from "next/link";

import { Change } from "./change";
import { formatCount } from "./format";

const TOTALS: readonly { key: PassportTotal; label: string; hint: string }[] = [
  {
    key: "stamps",
    label: "Sellos",
    hint: "Teléfonos que sellaron un lugar: cada teléfono cuenta una vez por lugar y día.",
  },
  {
    key: "located",
    label: "Visitas comprobadas en el lugar",
    hint: "Sellos con la ubicación del teléfono dentro del lugar.",
  },
  {
    key: "completed",
    label: "Circuitos completados",
    hint: "Teléfonos que juntaron todos los sellos de un circuito y pidieron su premio.",
  },
  { key: "redeemed", label: "Premios canjeados", hint: "Comprobantes canjeados en el local." },
];

/**
 * The tourist passport (C2 · Paso 4, ADR-059), in «Estadísticas» and the monthly report:
 * its totals, each place with the views of its page next to its stamps, and each circuit.
 */
export function PassportSection({
  org,
  passport,
  headingId,
  period,
}: {
  readonly org: string;
  readonly passport: PassportSummary;
  readonly headingId: string;
  /** «en este período», «en el mes». */
  readonly period: string;
}) {
  const places = passport.places.filter((place) => place.stop || place.stamps > 0);
  return (
    <section aria-labelledby={headingId} className="metrics-section">
      <h2 id={headingId}>Pasaporte turístico</h2>
      <p className="field-hint">
        Los sellos con QR de cada lugar. Un sello «con ubicación» es una visita comprobada: el
        teléfono estaba en el lugar al sellar.
      </p>
      {!passport.compared && passport.since ? (
        <p className="field-hint">
          Sin comparación: los sellos se cuentan desde el {formatShortDate(passport.since)}.
        </p>
      ) : null}
      <ul className="stats-tiles">
        {TOTALS.map(({ key, label, hint }) => (
          <li key={key} className="stats-tile">
            <span className="stats-tile-label">{label}</span>
            <span className="stats-tile-value">{formatCount(passport.totals[key].value)}</span>
            <Change measure={passport.totals[key]} />
            <span className="field-hint passport-tile-hint">{hint}</span>
          </li>
        ))}
      </ul>

      {places.length === 0 ? (
        <p className="field-hint">Ningún lugar se selló {period}.</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Sellos por lugar" tabIndex={0}>
          <table className="data-table metrics-table">
            <caption className="visually-hidden">
              Vistas de la ficha, sellos y visitas comprobadas de cada lugar del pasaporte
            </caption>
            <thead>
              <tr>
                <th scope="col">Lugar</th>
                <th scope="col">Vistas de la ficha</th>
                <th scope="col">Sellos</th>
                <th scope="col">Comprobadas en el lugar</th>
              </tr>
            </thead>
            <tbody>
              {places.map((place) => (
                <tr key={place.contentId}>
                  <th scope="row">
                    <Link href={`/o/${org}/destinos/${place.contentId}`}>{place.title}</Link>
                    {!place.stop ? (
                      <span className="org-detail">Ya no es parada de un circuito</span>
                    ) : null}
                  </th>
                  <td>{formatCount(place.views)}</td>
                  <td>{formatCount(place.stamps)}</td>
                  <td>{formatCount(place.located)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {passport.circuits.length > 0 ? (
        <>
          <h3 className="passport-stats-subtitle">Circuitos</h3>
          <ul className="metrics-list">
            {passport.circuits.map((circuit) => (
              <li key={circuit.circuitId}>
                <Link href={`/o/${org}/pasaporte/${circuit.circuitId}`}>{circuit.name}</Link>
                {circuit.published ? "" : " (retirado)"}:{" "}
                {circuit.completed === 0
                  ? "nadie lo completó"
                  : `${formatCount(circuit.completed)} ${circuit.completed === 1 ? "persona lo completó" : "personas lo completaron"}`}{" "}
                y {formatCount(circuit.redeemed)}{" "}
                {circuit.redeemed === 1 ? "premio canjeado" : "premios canjeados"}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
