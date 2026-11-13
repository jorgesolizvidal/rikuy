"use client";

import { formatVoucherCode } from "@rikuy/core/passport-client";
import { useRef, useState, type FormEvent } from "react";

interface VoucherDto {
  readonly code: string;
  readonly circuitName: string;
  readonly reward: string;
  readonly stampsTotal: number;
  readonly stampsLocated: number;
  readonly expiresAt: string;
  readonly redeemedAt: string | null;
}

type Answer =
  | {
      readonly status: "valid" | "redeemed" | "already_redeemed" | "expired";
      readonly voucher: VoucherDto;
    }
  | { readonly status: "no_pin"; readonly circuitName: string }
  | { readonly status: "wrong" | "too_many" | "invalid" | "forbidden" | "error" };

const WHEN: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("es-BO", WHEN);
}

const PROBLEMS: Record<string, string> = {
  wrong: "El código o la clave del local no son correctos.",
  too_many: "Hubo demasiados intentos fallidos en esta hora. Espera un rato e inténtalo de nuevo.",
  invalid: "Revisa el código (8 letras y números) y la clave (4 a 8 números).",
  forbidden: "Abre esta página desde la dirección del portal.",
  error: "No pudimos comprobarlo ahora. Revisa la conexión e intenta de nuevo.",
};

/** Check the voucher first; then mark it as redeemed, once. The key stays only in this page. */
export function RedeemForm() {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const result = useRef<HTMLDivElement>(null);

  async function send(redeem: boolean) {
    setBusy(true);
    let next: Answer;
    try {
      const response = await fetch("/canje/verificar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, pin, redeem }),
      });
      // A failure of the server is not a wrong key: saying so sends the shop after the wrong
      // problem.
      next = ((await response.json().catch(() => null)) as Answer | null) ?? { status: "error" };
    } catch {
      next = { status: "error" };
    }
    setBusy(false);
    setAnswer(next);
    requestAnimationFrame(() => result.current?.focus());
  }

  function check(event: FormEvent) {
    event.preventDefault();
    void send(false);
  }

  function another() {
    setCode("");
    setAnswer(null);
  }

  const voucher = answer && "voucher" in answer ? answer.voucher : null;

  return (
    <>
      <form className="redeem-form" onSubmit={check}>
        <label>
          <span>Código del comprobante</span>
          <input
            name="code"
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              setAnswer(null);
            }}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="ABCD-EFGH"
            maxLength={20}
            required
          />
        </label>
        <label>
          <span>Clave del local</span>
          {/* Plain text, not a password field: the browser's password manager would fill it
              with a saved password instead of the shop's key. */}
          <input
            name="shop-key"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            data-form-type="other"
            value={pin}
            onChange={(event) => {
              setPin(event.target.value.replace(/\s/gu, ""));
              setAnswer(null);
            }}
            maxLength={8}
            required
          />
        </label>
        <button type="submit" className="portal-button" disabled={busy}>
          {busy && answer === null ? "Comprobando…" : "Comprobar"}
        </button>
      </form>

      <div className="redeem-result" ref={result} tabIndex={-1} aria-live="polite">
        {answer === null ? null : voucher ? (
          <div data-status={answer.status}>
            <h2>
              {answer.status === "valid"
                ? "Comprobante válido"
                : answer.status === "redeemed"
                  ? "¡Canjeado! Entrega el premio."
                  : answer.status === "already_redeemed"
                    ? "Este comprobante ya se canjeó"
                    : "Este comprobante venció"}
            </h2>
            <dl>
              <dt>Código</dt>
              <dd>{formatVoucherCode(voucher.code)}</dd>
              <dt>Circuito</dt>
              <dd>{voucher.circuitName}</dd>
              <dt>Premio</dt>
              <dd>{voucher.reward}</dd>
              <dt>Sellos</dt>
              <dd>
                {voucher.stampsTotal}, {voucher.stampsLocated} con ubicación
              </dd>
              {voucher.redeemedAt ? (
                <>
                  <dt>Canjeado</dt>
                  <dd>{when(voucher.redeemedAt)}</dd>
                </>
              ) : (
                <>
                  <dt>Vale hasta</dt>
                  <dd>{when(voucher.expiresAt)}</dd>
                </>
              )}
            </dl>
            {answer.status === "valid" ? (
              <button
                type="button"
                className="portal-button"
                disabled={busy}
                onClick={() => void send(true)}
              >
                {busy ? "Canjeando…" : "Marcar como canjeado y entregar el premio"}
              </button>
            ) : (
              <button type="button" className="stamp-secondary" onClick={another}>
                Revisar otro comprobante
              </button>
            )}
          </div>
        ) : (
          <p className="redeem-problem" role="alert">
            {answer.status === "no_pin"
              ? `El circuito «${answer.circuitName}» todavía no tiene clave del local: pídesela al municipio.`
              : (PROBLEMS[answer.status] ?? PROBLEMS.error)}
          </p>
        )}
      </div>
    </>
  );
}
