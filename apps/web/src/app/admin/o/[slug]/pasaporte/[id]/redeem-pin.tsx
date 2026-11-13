"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { setRedeemPinAction } from "../actions";

const MESSAGES: Record<string, string> = {
  invalid: "La clave lleva de 4 a 8 números.",
  forbidden: "Solo propietarios y administradores cambian la clave del local.",
  not_found: "Este circuito ya no existe.",
  signed_out: "Tu sesión terminó. Vuelve a iniciar sesión.",
  error: "No pudimos guardar la clave. Intenta de nuevo.",
};

/**
 * Sets the shop's key; only its hash is kept. The field is plain text (not a password field)
 * so the person sees what they save and no password manager fills or changes it: a key typed
 * blind was saved wrong once in production. The confirmation repeats it, once.
 */
export function RedeemPinForm({
  org,
  circuitId,
  hasPin,
}: {
  readonly org: string;
  readonly circuitId: string;
  readonly hasPin: boolean;
}) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("");
  const [pending, startTransition] = useTransition();

  function save(event: FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const saved = pin;
      const result = await setRedeemPinAction(org, circuitId, saved);
      if (result.status === "saved") {
        setPin("");
        setMessage(`Se guardó la clave ${saved}. Anótala y dásela al local que entrega el premio.`);
        router.refresh();
        return;
      }
      setMessage(MESSAGES[result.status] ?? MESSAGES.error ?? "");
    });
  }

  return (
    <form className="redeem-pin-form" onSubmit={save}>
      <label className="field">
        <span>{hasPin ? "Clave nueva del local" : "Clave del local"}</span>
        <input
          name="shop-key"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          data-form-type="other"
          pattern="[0-9]{4,8}"
          minLength={4}
          maxLength={8}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\s/gu, ""))}
          aria-describedby="clave-ayuda"
          required
        />
        <span id="clave-ayuda" className="field-hint">
          De 4 a 8 números. Después de guardarla no se vuelve a mostrar: anótala para dársela al
          local.
          {hasPin ? " Al cambiarla, la anterior deja de servir." : ""}
        </span>
      </label>
      <button type="submit" className="button" disabled={pending}>
        {pending ? "Guardando…" : hasPin ? "Cambiar la clave" : "Guardar la clave"}
      </button>
      <p className="field-hint" role="status" aria-live="polite">
        {message}
      </p>
    </form>
  );
}
