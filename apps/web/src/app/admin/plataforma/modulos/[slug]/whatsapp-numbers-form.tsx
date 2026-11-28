"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId } from "react";

import { changeWhatsAppNumberAction, type WhatsAppNumbersState } from "../actions";

const MESSAGES: Partial<Record<WhatsAppNumbersState["status"], string>> = {
  added: "Se registró el número. Los mensajes que lleguen a él los responde el asistente.",
  removed: "Se quitó el número. Los mensajes que lleguen a él ya no se responden.",
  invalid: "El identificador del número son solo números, como lo muestra Meta.",
  display:
    "Escribe el número con + y el código del país (por ejemplo +591 67680091), o déjalo vacío.",
  taken: "Ese número ya está registrado en otro municipio.",
  too_many: "Un municipio puede tener hasta 3 números.",
  not_found: "Ese municipio ya no existe.",
  forbidden: "Tu sesión de operador ya no es válida. Recarga la página.",
  error: "No se pudo guardar. Inténtalo de nuevo en unos segundos.",
};

/**
 * «Números de WhatsApp» (ADR-075): the operator registers the number of a municipality's
 * assistant with the «Identificador del número de teléfono» that Meta shows for it.
 */
export function WhatsAppNumbersForm({
  tenantId,
  displayName,
  numbers,
  configured,
  webhookUrl,
}: {
  readonly tenantId: string;
  readonly displayName: string;
  readonly numbers: readonly {
    readonly phoneNumberId: string;
    readonly displayPhone: string | null;
  }[];
  readonly configured: boolean;
  readonly webhookUrl: string;
}) {
  const id = useId();
  const router = useRouter();
  const [state, dispatch, pending] = useActionState(changeWhatsAppNumberAction, {
    status: "idle",
  } as WhatsAppNumbersState);

  useEffect(() => {
    if (state.status === "added" || state.status === "removed") router.refresh();
  }, [state, router]);

  const message = MESSAGES[state.status] ?? null;
  const ok = state.status === "added" || state.status === "removed";

  return (
    <section aria-labelledby={`${id}-heading`} className="embed-section">
      <h2 id={`${id}-heading`}>Números de WhatsApp</h2>
      <p className="field-hint">
        El asistente de {displayName} responde los mensajes que llegan a estos números. En Meta, el
        webhook de la app es <code>{webhookUrl}</code>, con el campo «messages».
      </p>
      {configured ? null : (
        <p className="notice">
          WhatsApp no está configurado en la plataforma (o falta la IA): los números se guardan,
          pero nadie responde hasta configurarlo.
        </p>
      )}
      {numbers.length === 0 ? (
        <p className="notice">Ninguno todavía.</p>
      ) : (
        <ul className="embed-origins">
          {numbers.map((entry) => (
            <li key={entry.phoneNumberId}>
              <form action={dispatch} className="embed-origin-row">
                <input type="hidden" name="tenantId" value={tenantId} />
                <input type="hidden" name="phoneNumberId" value={entry.phoneNumberId} />
                <input type="hidden" name="intent" value="remove" />
                <span>
                  {entry.displayPhone ?? "Sin número a la vista"} ·{" "}
                  <code>{entry.phoneNumberId}</code>
                </span>
                <button type="submit" className="button button-quiet" disabled={pending}>
                  Quitar<span className="visually-hidden"> {entry.phoneNumberId}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      <form action={dispatch} className="embed-origin-add">
        <input type="hidden" name="tenantId" value={tenantId} />
        <input type="hidden" name="intent" value="add" />
        <div className="field">
          <label htmlFor={`${id}-id`}>Identificador del número de teléfono (de Meta)</label>
          <input
            id={`${id}-id`}
            name="phoneNumberId"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            pattern="[0-9]{5,30}"
            required
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-display`}>Número para los visitantes (opcional)</label>
          <input
            id={`${id}-display`}
            name="displayPhone"
            inputMode="tel"
            autoComplete="off"
            placeholder="+591 70000000"
          />
        </div>
        <button type="submit" className="button" disabled={pending}>
          Registrar el número
        </button>
      </form>
      {message ? (
        <p className={ok ? "notice" : "field-error"} role={ok ? "status" : "alert"}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
