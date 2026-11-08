"use client";

import { useActionState, useState } from "react";

import { resetSecondFactorAction, type ResetState } from "./actions";

const ERRORS: Partial<Record<ResetState["status"], string>> = {
  invalid_email: "Escribe un correo válido.",
  not_found:
    "Esa persona no es propietaria ni administradora de ningún municipio: no necesita verificación en dos pasos.",
  self: "No puedes restablecer tu propia verificación aquí.",
  forbidden: "Hace falta la verificación en dos pasos de operador.",
  error: "No pudimos restablecerla. Inténtalo de nuevo.",
};

/** Two steps: the email, then an explicit confirmation naming the person. */
export function ResetSecondFactorForm() {
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [state, action, pending] = useActionState(
    async (previous: ResetState, formData: FormData) => {
      const next = await resetSecondFactorAction(previous, formData);
      setConfirming(false);
      if (next.status === "reset") setEmail("");
      return next;
    },
    { status: "idle" } as ResetState,
  );
  const error = ERRORS[state.status];

  return (
    <form action={action} className="form">
      <label className="field">
        <span>Correo de la persona</span>
        <input
          type="email"
          name="email"
          autoComplete="off"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setConfirming(false);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby="reset-status"
        />
      </label>
      <div className="form-actions">
        {confirming ? (
          <>
            {/* Distinct keys: React must not turn the clicked «Restablecer» button into this
                submit button during the same click (the browser would then submit). */}
            <button key="confirm" type="submit" className="button" disabled={pending}>
              {pending ? "Restableciendo…" : `Confirmar: restablecer a ${email.trim()}`}
            </button>
            <button
              key="cancel"
              type="button"
              className="button button-quiet"
              onClick={() => setConfirming(false)}
            >
              Cancelar
            </button>
          </>
        ) : (
          <button
            key="start"
            type="button"
            className="button"
            disabled={email.trim() === ""}
            onClick={() => setConfirming(true)}
          >
            Restablecer la verificación en dos pasos
          </button>
        )}
      </div>
      <p id="reset-status" role="status" className={error ? "form-error" : "field-hint"}>
        {state.status === "reset"
          ? `Listo: ${state.email} configurará una app nueva la próxima vez que abra su municipio${
              state.removed === 0 ? " (todavía no tenía ninguna configurada)" : ""
            }.`
          : (error ?? "")}
      </p>
    </form>
  );
}
