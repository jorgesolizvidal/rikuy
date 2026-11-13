"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { sendMonthlyReportAction, type SendReportState } from "./actions";

/** «Imprimir o guardar como PDF»: the browser's print dialog (the page has print styles). */
export function PrintButton() {
  return (
    <button type="button" className="button" onClick={() => window.print()}>
      Imprimir o guardar como PDF
    </button>
  );
}

const MESSAGES: Partial<Record<SendReportState["status"], string>> = {
  queued:
    "Listo: el informe está en camino. Llega a propietarios y administradores en uno o dos minutos.",
  too_many: "Ya se pidió 3 veces hoy. Prueba mañana.",
  not_online: "El portal no está en línea: el informe por correo se envía cuando lo esté.",
  invalid: "Ese mes no se puede enviar.",
  forbidden: "Solo propietarios y administradores pueden enviar el informe.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No pudimos pedir el informe. Prueba de nuevo en unos segundos.",
};

/**
 * «Enviar este informe ahora por correo»: the platform generates the month's recommendations
 * again and emails owners and admins (owners and admins, up to 3 times a day).
 */
export function SendReportForm({
  org,
  month,
  disabled,
}: {
  readonly org: string;
  readonly month: string;
  /** Already on its way, or asked for 3 times today. */
  readonly disabled: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(sendMonthlyReportAction, {
    status: "idle",
  } satisfies SendReportState);

  useEffect(() => {
    if (state.status === "queued") router.refresh();
  }, [state, router]);

  return (
    <form action={action} className="report-send" aria-busy={pending}>
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="month" value={month} />
      <button type="submit" className="button button-quiet" disabled={pending || disabled}>
        {pending ? "Pidiendo…" : "Enviar este informe ahora por correo"}
      </button>
      <p className="field-hint">
        Genera de nuevo las recomendaciones del mes (usa la cuota de IA del municipio) y envía el
        resumen a propietarios y administradores. Hasta 3 veces por día.
      </p>
      <p role="status" aria-live="polite" className="report-send-status">
        {pending ? "" : (MESSAGES[state.status] ?? "")}
      </p>
    </form>
  );
}
