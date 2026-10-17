"use client";

import { useActionState } from "react";

import { loginAction, type LoginState } from "./actions";

export function LoginForm({ initialError }: { readonly initialError?: string }) {
  const initial: LoginState = initialError
    ? { stage: "email", error: initialError }
    : { stage: "email" };
  const [state, action, pending] = useActionState(loginAction, initial);
  const errorProps = state.error
    ? { "aria-invalid": true as const, "aria-describedby": "login-error" }
    : {};

  return (
    <form action={action} className="form" noValidate>
      {state.stage === "code" ? (
        <>
          <p className="lead">
            Si <strong>{state.email}</strong> tiene acceso, te enviamos un código de 6 dígitos.
            También puedes entrar con el enlace del correo.
          </p>
          <label className="field">
            <span>Código de acceso</span>
            <input
              key="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              required
              autoFocus
              {...errorProps}
            />
          </label>
        </>
      ) : (
        <label className="field">
          <span>Correo electrónico</span>
          <input
            key="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            {...errorProps}
          />
        </label>
      )}

      {state.error ? (
        <p id="login-error" className="form-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="form-actions">
        {state.stage === "code" ? (
          <>
            <button
              type="submit"
              name="intent"
              value="verify"
              className="button"
              disabled={pending}
            >
              {pending ? "Verificando…" : "Entrar"}
            </button>
            <button
              type="submit"
              name="intent"
              value="restart"
              className="button button-quiet"
              formNoValidate
            >
              Usar otro correo
            </button>
          </>
        ) : (
          <button type="submit" name="intent" value="request" className="button" disabled={pending}>
            {pending ? "Enviando…" : "Recibir código"}
          </button>
        )}
      </div>
    </form>
  );
}
