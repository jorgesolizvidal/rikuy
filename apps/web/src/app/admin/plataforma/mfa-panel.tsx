"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import {
  startEnrollmentAction,
  verifyOperatorAction,
  type EnrollState,
  type VerifyState,
} from "./actions";

const VERIFY_MESSAGES: Partial<Record<VerifyState["status"], string>> = {
  invalid_code: "El código no es válido o ya cambió. Escribe el que muestra ahora tu app.",
  rate_limited: "Demasiados intentos. Espera un momento.",
  unavailable: "No pudimos verificar el código. Inténtalo de nuevo.",
  denied: "Tu sesión ya no es válida. Vuelve a iniciar sesión.",
};

export function MfaPanel({
  mode,
  factorId,
}: {
  readonly mode: "enroll" | "verify";
  readonly factorId: string | null;
}) {
  const [enrollment, setEnrollment] = useState<EnrollState>({ status: "idle" });
  const [starting, startTransition] = useTransition();
  const [state, verify, verifying] = useActionState(verifyOperatorAction, {
    status: "idle",
  } as VerifyState);

  useEffect(() => {
    // The session cookies now carry the second factor: reload through the proxy.
    if (state.status === "verified") window.location.reload();
  }, [state]);

  const activeFactor =
    mode === "verify" ? factorId : enrollment.status === "enrolling" ? enrollment.factorId : null;

  return (
    <div className="form">
      {mode === "enroll" && enrollment.status !== "enrolling" ? (
        <>
          <button
            type="button"
            className="button"
            disabled={starting}
            onClick={() =>
              startTransition(async () => setEnrollment(await startEnrollmentAction()))
            }
          >
            {starting ? "Preparando…" : "Configurar la app de autenticación"}
          </button>
          {enrollment.status === "error" || enrollment.status === "denied" ? (
            <p className="form-error" role="alert">
              No pudimos iniciar la configuración. Recarga la página e inténtalo de nuevo.
            </p>
          ) : null}
        </>
      ) : null}

      {enrollment.status === "enrolling" ? (
        <div className="mfa-enroll">
          <p>Escanea este código con tu app de autenticación:</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- inline SVG data URI from Auth */}
          <img
            src={enrollment.qrCode}
            alt="Código QR para configurar la app de autenticación"
            width={200}
            height={200}
          />
          <p className="field-hint">
            ¿No puedes escanearlo? Escribe esta clave en la app:{" "}
            <code className="secret">{enrollment.secret}</code>
          </p>
        </div>
      ) : null}

      {activeFactor ? (
        <form action={verify} className="form">
          <input type="hidden" name="factorId" value={activeFactor} />
          <label className="field">
            <span>Código de 6 dígitos</span>
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              required
              autoFocus
              aria-invalid={VERIFY_MESSAGES[state.status] ? true : undefined}
              aria-describedby={VERIFY_MESSAGES[state.status] ? "mfa-error" : undefined}
            />
          </label>
          {VERIFY_MESSAGES[state.status] ? (
            <p id="mfa-error" className="form-error" role="alert">
              {VERIFY_MESSAGES[state.status]}
            </p>
          ) : null}
          <div className="form-actions">
            <button type="submit" className="button" disabled={verifying}>
              {verifying ? "Verificando…" : "Verificar"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
