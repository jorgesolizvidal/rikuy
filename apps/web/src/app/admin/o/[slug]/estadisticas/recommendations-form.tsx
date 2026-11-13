"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import { generateRecommendationsAction, type RecommendState } from "./actions";

const MESSAGES: Partial<Record<RecommendState["status"], string>> = {
  forbidden: "Tu rol ya no permite usar el Copilot en este municipio.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No pudimos generar las recomendaciones. Prueba de nuevo en unos segundos.",
};

/** «Generar recomendaciones»: one request to the Copilot; the page shows the saved set. */
export function RecommendationsForm({
  org,
  enabled,
  hasSaved,
}: {
  readonly org: string;
  readonly enabled: boolean;
  readonly hasSaved: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(generateRecommendationsAction, {
    status: "idle",
  } satisfies RecommendState);

  useEffect(() => {
    if (state.status === "saved") router.refresh();
  }, [state, router]);

  const message =
    state.status === "saved"
      ? `Listo: ${state.count === 1 ? "1 recomendación nueva" : `${state.count ?? 0} recomendaciones nuevas`}.`
      : state.status === "notice"
        ? state.message
        : MESSAGES[state.status];

  if (!enabled) {
    return (
      <p className="notice" role="status">
        El Copilot no está disponible en esta plataforma por ahora: no se pueden generar
        recomendaciones.
      </p>
    );
  }
  return (
    <form action={action} className="recommendations-form" aria-busy={pending}>
      <input type="hidden" name="org" value={org} />
      <button type="submit" className="button" disabled={pending}>
        {pending
          ? "Generando… (unos segundos)"
          : hasSaved
            ? "Generar recomendaciones nuevas"
            : "Generar recomendaciones"}
      </button>
      <p className="field-hint">
        Usa la cuota de IA del municipio (unos miles de tokens). Reemplaza a las anteriores.
      </p>
      <p role="status" aria-live="polite" className="recommendations-status">
        {pending ? "" : (message ?? "")}
      </p>
    </form>
  );
}
