"use client";

import type { SampleContentStatus } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

import { QUOTA_MESSAGES } from "@/lib/quota-messages";

import {
  buildSampleTourAction,
  loadSampleContentAction,
  type LoadSampleState,
  type SampleTourState,
} from "./actions";

const GENERIC = "Algo falló. Vuelve a intentarlo en unos segundos.";

const LOAD_MESSAGES: Partial<Record<LoadSampleState["status"], string>> = {
  invalid_center:
    "No reconocemos esas coordenadas. Pega la latitud y la longitud, por ejemplo -17.3901, -66.1502.",
  rate_limited: "Hay demasiadas subidas en curso. Espera unos minutos y vuelve a intentarlo.",
  failed:
    "No se pudo cargar todo. Vuelve a pulsar «Cargar contenido de muestra»: se completa lo que falta sin repetir nada.",
  not_demo: "Este municipio no es una demo comercial.",
  forbidden: "Solo el propietario o un administrador pueden cargar el contenido de muestra.",
  signed_out: "Tu sesión terminó. Vuelve a iniciar sesión.",
  error: "Algo falló. Vuelve a intentarlo en unos segundos.",
};

const TOUR_MESSAGES: Partial<Record<SampleTourState["status"], string>> = {
  no_place: "Primero carga el contenido de muestra: el tour es de la plaza principal.",
  exists: "La plaza principal ya tiene un tour.",
  rate_limited: "Hay demasiadas subidas en curso. Espera unos minutos y vuelve a intentarlo.",
  failed: "No se pudo armar el tour. Vuelve a intentarlo.",
  not_demo: "Este municipio no es una demo comercial.",
  forbidden: "Solo el propietario o un administrador pueden armar el tour de muestra.",
  signed_out: "Tu sesión terminó. Vuelve a iniciar sesión.",
  error: "Algo falló. Vuelve a intentarlo en unos segundos.",
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function SamplePanel({
  slug,
  status,
  portalUrl,
  online,
}: {
  readonly slug: string;
  readonly status: SampleContentStatus;
  readonly portalUrl: string | null;
  readonly online: boolean;
}) {
  const router = useRouter();
  const id = useId();
  const [center, setCenter] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<"load" | "tour" | null>(null);

  function load(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAction("load");
    setMessage(null);
    startTransition(async () => {
      const result = await loadSampleContentAction(slug, center);
      if (result.status === "loaded") {
        setMessage({
          error: false,
          text:
            `Listo: ${plural(result.destinations, "destino", "destinos")} y ` +
            `${plural(result.events, "evento", "eventos")} publicados` +
            (result.panoramas > 0
              ? `, y ${plural(result.panoramas, "panorama", "panoramas")} en proceso para el tour.`
              : "."),
        });
        router.refresh();
      } else if (result.status === "over_quota") {
        setMessage({ error: true, text: QUOTA_MESSAGES[result.resource] });
      } else {
        setMessage({ error: true, text: LOAD_MESSAGES[result.status] ?? GENERIC });
        if (result.status === "failed") router.refresh();
      }
    });
  }

  function tour() {
    setAction("tour");
    setMessage(null);
    startTransition(async () => {
      const result = await buildSampleTourAction(slug);
      if (result.status === "built") {
        setMessage({ error: false, text: "Se publicó el tour de muestra de la plaza principal." });
        router.refresh();
      } else if (result.status === "processing") {
        setMessage({
          error: false,
          text:
            result.uploaded > 0
              ? "Se subieron de nuevo los panoramas de muestra. Cuando terminen de procesarse, arma el tour."
              : "Los panoramas todavía se están procesando. Cuando terminen, arma el tour.",
        });
        router.refresh();
      } else if (result.status === "over_quota") {
        setMessage({ error: true, text: QUOTA_MESSAGES[result.resource] });
      } else {
        setMessage({ error: true, text: TOUR_MESSAGES[result.status] ?? GENERIC });
      }
    });
  }

  return (
    <div className="sample-panel">
      <section aria-labelledby={`${id}-content`} className="members-invite">
        <h2 id={`${id}-content`}>1. Destinos y eventos</h2>
        {status.loaded ? (
          <p className="notice" role="status">
            El contenido de muestra ya está cargado. Edítalo desde «Destinos» y «Agenda».
          </p>
        ) : (
          <form className="form" onSubmit={load} noValidate>
            {status.partial ? (
              <p className="notice">
                Una carga anterior quedó a medias: vuelve a cargarla y se completa lo que falta.
              </p>
            ) : null}
            <div className="field">
              <label htmlFor={`${id}-center`}>Centro del municipio</label>
              <p className="field-hint" id={`${id}-center-hint`}>
                Las coordenadas de la plaza principal, como las copia Google Maps (clic derecho
                sobre el lugar). Los demás lugares se ubican alrededor, a menos de 2 km.
              </p>
              <input
                id={`${id}-center`}
                value={center}
                onChange={(event) => setCenter(event.target.value)}
                placeholder="-17.3901, -66.1502"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                required
                aria-describedby={`${id}-center-hint`}
              />
            </div>
            <div className="form-actions">
              <button type="submit" className="button" disabled={pending || center.trim() === ""}>
                {pending && action === "load"
                  ? "Cargando… (alrededor de un minuto)"
                  : "Cargar contenido de muestra"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section aria-labelledby={`${id}-tour`} className="members-invite">
        <h2 id={`${id}-tour`}>2. Tour 360° de la plaza</h2>
        {status.tour === "none" ? (
          <p className="field-hint">Primero carga los destinos y eventos.</p>
        ) : status.tour === "built" ? (
          <p className="notice" role="status">
            El tour de muestra está publicado. Edítalo desde «Tours 360°».
          </p>
        ) : status.tour === "processing" ? (
          <p className="notice" role="status">
            Los panoramas de muestra se están procesando. Esta página se actualiza sola.
          </p>
        ) : (
          <>
            <p className="field-hint">
              {status.tour === "ready"
                ? "Usa los dos panoramas listos más recientes: dos escenas unidas por flechas y un punto de información."
                : "No hay panoramas listos: se suben de nuevo los de muestra para armar el tour."}
            </p>
            <div className="form-actions">
              <button type="button" className="button" disabled={pending} onClick={tour}>
                {pending && action === "tour" ? "Armando el tour…" : "Armar el tour de muestra"}
              </button>
            </div>
          </>
        )}
      </section>

      {message ? (
        <p
          className={message.error ? "form-error" : "notice"}
          role={message.error ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}

      {portalUrl ? (
        <p className="field-hint">
          {online ? (
            <>
              Portal de la demo:{" "}
              <a href={portalUrl} target="_blank" rel="noopener noreferrer">
                {portalUrl}
                <span className="visually-hidden"> (se abre en otra pestaña)</span>
              </a>
              . No aparece en buscadores y avisa que es una demostración.
            </>
          ) : (
            <>
              El portal de la demo ({portalUrl}) funcionará cuando el operador lo ponga en línea. No
              aparecerá en buscadores y avisará que es una demostración.
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}
