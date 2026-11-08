"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { prepareFixturesAction, retireFixturesAction } from "./actions";

const MESSAGES: Readonly<Record<string, string>> = {
  prepared:
    "Listos. El asistente los lee en unos segundos: recarga la página hasta que no diga «la está leyendo».",
  retired: "Retirados: el asistente y el portal ya no los ven.",
  not_demo: "Solo se preparan en una demo comercial.",
  forbidden:
    "Tienes que ser propietario o administrador de esa demo, con la verificación en dos pasos.",
  not_member:
    "Tienes que ser propietario o administrador de esa demo, con la verificación en dos pasos.",
  no_place: "La demo B necesita su contenido de muestra (la plaza principal publicada).",
  invalid: "Solo se retiran en una demo comercial.",
  signed_out: "Tu sesión terminó: vuelve a entrar.",
  failed: "No pudimos preparar todo. Inténtalo de nuevo.",
  error: "Algo falló. Inténtalo de nuevo.",
};

/** «Preparar los datos de prueba» and «Retirar los datos de prueba» in demo B. */
export function FixtureButtons({ tenantId }: { readonly tenantId: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const act = (action: (id: string) => Promise<{ readonly status: string }>) =>
    startTransition(async () => {
      const result = await action(tenantId);
      setMessage(MESSAGES[result.status] ?? MESSAGES.error ?? "");
      router.refresh();
    });

  return (
    <div>
      <div className="eval-actions">
        <button
          type="button"
          className="button"
          disabled={pending}
          onClick={() => act(prepareFixturesAction)}
        >
          Preparar los datos de prueba
        </button>
        <button
          type="button"
          className="button button-quiet"
          disabled={pending}
          onClick={() => act(retireFixturesAction)}
        >
          Retirar los datos de prueba
        </button>
      </div>
      <p className="field-hint" role="status">
        {pending ? "Un momento…" : (message ?? "")}
      </p>
    </div>
  );
}
