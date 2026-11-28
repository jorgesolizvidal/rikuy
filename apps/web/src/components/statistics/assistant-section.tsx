import {
  ASSISTANT_CHANNEL_KEYS,
  formatShortDate,
  type AssistantChannelKey,
  type AssistantSummary,
  type AssistantTotal,
  type CitedKind,
} from "@rikuy/core";
import Link from "next/link";

import { Change } from "./change";
import { formatCount } from "./format";

const TOTALS: readonly { key: AssistantTotal; label: string; hint: string }[] = [
  { key: "conversations", label: "Preguntas", hint: "Respuestas del asistente." },
  {
    key: "people",
    label: "Personas",
    hint: "Personas distintas en un día, sumadas, como los visitantes del portal.",
  },
  {
    key: "abstained",
    label: "Sin respuesta",
    hint: "No encontró nada publicado que respondiera la pregunta.",
  },
  {
    key: "askedPerson",
    label: "Pidieron una persona",
    hint: "Después tocaron WhatsApp, «Llamar» o el correo de «Hablar con una persona».",
  },
  {
    key: "withAction",
    label: "Tocaron algo de la respuesta",
    hint: "Una ficha, un tour, el mapa, una sección o «Hablar con una persona».",
  },
];

const EDITOR: Readonly<Record<CitedKind, string>> = {
  destination: "destinos",
  event: "agenda",
  knowledge: "conocimiento",
  notice: "avisos",
  service: "servicios",
  story: "memoria",
  faq: "preguntas-frecuentes",
};

/**
 * The visitor's assistant by channel (A · Paso 5.1, ADR-074), in «Estadísticas» and the monthly
 * report: by channel, the most asked topics (what the answers cited) and what was tapped.
 */
export function AssistantSection({
  org,
  assistant,
  headingId,
  period,
}: {
  readonly org: string;
  readonly assistant: AssistantSummary;
  readonly headingId: string;
  /** «en este período», «en el mes». */
  readonly period: string;
}) {
  return (
    <section aria-labelledby={headingId} className="metrics-section">
      <h2 id={headingId}>El asistente por canal</h2>
      <p className="field-hint">
        Las preguntas al asistente en el portal, en la web del municipio y desde los QR «Pregúntale
        a…». Sin el texto de las preguntas ni nada de quien pregunta.
      </p>
      {!assistant.compared && assistant.since ? (
        <p className="field-hint">
          Sin comparación: se cuenta desde el {formatShortDate(assistant.since)}.
        </p>
      ) : null}
      <ul className="stats-tiles">
        {TOTALS.map(({ key, label, hint }) => (
          <li key={key} className="stats-tile">
            <span className="stats-tile-label">{label}</span>
            <span className="stats-tile-value">{formatCount(assistant.totals[key].value)}</span>
            <Change measure={assistant.totals[key]} />
            <span className="field-hint passport-tile-hint">{hint}</span>
          </li>
        ))}
      </ul>

      {assistant.empty ? (
        <p className="field-hint">Nadie le preguntó al asistente {period}.</p>
      ) : (
        <>
          <div className="table-wrap" role="region" aria-label="Preguntas por canal" tabIndex={0}>
            <table className="data-table metrics-table">
              <caption className="visually-hidden">
                Preguntas, personas, sin respuesta, pidieron una persona y tocaron algo, por canal
              </caption>
              <thead>
                <tr>
                  <th scope="col">Canal</th>
                  <th scope="col">Preguntas</th>
                  <th scope="col">Personas</th>
                  <th scope="col">Sin respuesta</th>
                  <th scope="col">Pidieron una persona</th>
                  <th scope="col">Tocaron algo</th>
                </tr>
              </thead>
              <tbody>
                {assistant.channels.map((row) => (
                  <tr key={row.channel}>
                    <th scope="row">
                      {row.name}
                      <span className="org-detail">{row.share} % de las preguntas</span>
                    </th>
                    <td>{formatCount(row.conversations)}</td>
                    <td>{formatCount(row.people)}</td>
                    <td>{formatCount(row.abstained)}</td>
                    <td>{formatCount(row.askedPerson)}</td>
                    <td>{formatCount(row.withAction)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="passport-stats-subtitle">Los temas más preguntados</h3>
          {assistant.topics.length === 0 ? (
            <p className="field-hint">Ninguna respuesta citó algo publicado {period}.</p>
          ) : (
            <ol className="metrics-list">
              {assistant.topics.map((topic) => (
                <li key={topic.contentId}>
                  <Link href={`/o/${org}/${EDITOR[topic.kind]}/${topic.contentId}`}>
                    {topic.title}
                  </Link>{" "}
                  <span className="org-detail">
                    {topic.kindName}
                    {topic.published ? "" : " · sin publicar ahora"}
                  </span>
                  : {formatCount(topic.times)} {topic.times === 1 ? "respuesta" : "respuestas"}
                  {channelsOf(topic.channels)}
                </li>
              ))}
            </ol>
          )}

          <h3 className="passport-stats-subtitle">Qué tocaron después</h3>
          {assistant.actions.length === 0 ? (
            <p className="field-hint">Nadie tocó algo de una respuesta {period}.</p>
          ) : (
            <ul className="metrics-list">
              {assistant.actions.map((action) => (
                <li key={action.action}>
                  {action.name}: {formatCount(action.times)} {action.times === 1 ? "vez" : "veces"},
                  en {formatCount(action.answers)}{" "}
                  {action.answers === 1 ? "respuesta" : "respuestas"}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** « (8 en el portal, 3 desde un QR)» when more than one channel cited it. */
function channelsOf(channels: Readonly<Record<AssistantChannelKey, number>>) {
  const used = ASSISTANT_CHANNEL_KEYS.filter((key) => channels[key] > 0).map(
    (key) => `${formatCount(channels[key])} ${SHORT[key]}`,
  );
  return used.length > 1 ? ` (${used.join(", ")})` : null;
}

const SHORT: Readonly<Record<AssistantChannelKey, string>> = {
  portal: "en el portal",
  embed: "en la web del municipio",
  qr: "desde un QR",
  whatsapp: "por WhatsApp",
};
