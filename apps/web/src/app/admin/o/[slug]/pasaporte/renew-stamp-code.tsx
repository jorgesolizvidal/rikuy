"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { renewStampCodeAction } from "./actions";

const MESSAGES: Record<string, string> = {
  stale: "Alguien cambió este código mientras lo veías. Recarga la página.",
  forbidden: "Solo propietarios y administradores renuevan los códigos.",
  not_found: "Este lugar ya no tiene código.",
  signed_out: "Tu sesión terminó. Vuelve a iniciar sesión.",
  error: "No pudimos renovar el código. Intenta de nuevo.",
};

/** «Renovar el QR», with a confirmation that says what happens to the printed one. */
export function RenewStampCode({
  org,
  contentId,
  version,
  title,
}: {
  readonly org: string;
  readonly contentId: string;
  readonly version: number;
  readonly title: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function renew() {
    startTransition(async () => {
      const result = await renewStampCodeAction(org, contentId, version);
      if (result.status === "renewed") {
        setConfirming(false);
        setMessage("Se renovó: imprime el código nuevo. El anterior ya no sella.");
        router.refresh();
        return;
      }
      setMessage(MESSAGES[result.status] ?? MESSAGES.error ?? "");
    });
  }

  return (
    <div className="stamp-code-renew">
      {confirming ? (
        <>
          <p>
            ¿Renovar el código de «{title}»? El que está impreso dejará de sellar y tendrás que
            imprimir el nuevo. Los sellos que ya tienen los visitantes siguen valiendo.
          </p>
          <button
            key="confirm"
            type="button"
            className="button button-danger"
            disabled={pending}
            onClick={renew}
          >
            Sí, renovar
          </button>{" "}
          <button
            key="cancel"
            type="button"
            className="button button-quiet"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Cancelar
          </button>
        </>
      ) : (
        <button
          key="ask"
          type="button"
          className="button button-quiet"
          onClick={() => {
            setMessage("");
            setConfirming(true);
          }}
        >
          Renovar el QR
        </button>
      )}
      <p className="field-hint" role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
