"use client";

import {
  circuitProgress,
  formatVoucherCode,
  type StoredVoucher,
} from "@rikuy/core/passport-client";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { keepVoucher, usePassport } from "@/lib/passport-store";

interface VoucherDto {
  readonly code: string;
  readonly reward: string;
  readonly stampsTotal: number;
  readonly stampsLocated: number;
  readonly expiresAt: string;
  readonly redeemedAt: string | null;
}

type Answer =
  | { readonly status: "issued" | "active" | "redeemed"; readonly voucher: VoucherDto }
  | { readonly status: "incomplete"; readonly missing: number }
  | { readonly status: "no_reward" | "not_found" | "invalid" };

const DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("es-BO", DATE);
}

/**
 * «Pedir mi premio» (ADR-058), on a circuit's page. With every stop stamped, the phone sends
 * its stamps; the municipality checks their signatures and answers with a voucher to show
 * at the shop. The voucher is kept in this phone; when the page opens again it asks whether
 * it was redeemed (or gives a new one if it expired without being used).
 */
export function CircuitReward({
  circuit,
  reward,
  stopIds,
}: {
  readonly circuit: string;
  readonly reward: string;
  readonly stopIds: readonly (string | null)[];
}) {
  const passport = usePassport();
  const [details, setDetails] = useState<VoucherDto | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refreshed = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  const complete = passport ? circuitProgress(stopIds, passport.stamps).complete : false;
  const kept: StoredVoucher | undefined = passport?.vouchers?.[circuit];

  async function ask(focus: boolean) {
    if (!passport) return;
    // Asking already tells whether it was redeemed: no second request when it gets kept.
    refreshed.current = true;
    setBusy(true);
    setMessage("");
    let answer: Answer | null = null;
    try {
      const response = await fetch("/premio", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          circuit,
          passport: passport.id,
          stamps: Object.values(passport.stamps).map((stamp) => ({
            placeId: stamp.placeId,
            at: stamp.at,
            located: stamp.located,
            signature: stamp.signature,
          })),
        }),
      });
      answer = (await response.json().catch(() => null)) as Answer | null;
    } catch {
      answer = null;
    }
    setBusy(false);
    if (answer === null) {
      setMessage("No pudimos pedir tu premio: revisa tu conexión e intenta de nuevo.");
      return;
    }
    if ("voucher" in answer) {
      const voucher = answer.voucher;
      setDetails(voucher);
      if (
        !keepVoucher(circuit, {
          code: voucher.code,
          expiresAt: voucher.expiresAt,
          redeemedAt: voucher.redeemedAt,
        })
      ) {
        setMessage(
          "No pudimos guardar el comprobante en este teléfono: anota el código o sácale una captura.",
        );
      }
      if (focus) requestAnimationFrame(() => heading.current?.focus());
      return;
    }
    setMessage(
      answer.status === "incomplete"
        ? `Te ${answer.missing === 1 ? "falta 1 sello" : `faltan ${answer.missing} sellos`} de este circuito.`
        : answer.status === "no_reward"
          ? "Este circuito no tiene premio."
          : "No pudimos pedir tu premio. Intenta de nuevo en un momento.",
    );
  }

  // A voucher kept from before: was it redeemed, or did it expire? Asked once per visit.
  const refresh = useEffectEvent(() => {
    void ask(false);
  });
  const hasKept = kept !== undefined;
  useEffect(() => {
    if (!hasKept || !complete || refreshed.current) return;
    refresh();
  }, [hasKept, complete]);

  if (passport === undefined || !reward) return <div className="circuit-reward" id="premio" />;
  if (!complete) return <div className="circuit-reward" id="premio" />;

  const shown = details ?? (kept ? { ...kept, reward, stampsTotal: 0, stampsLocated: 0 } : null);

  return (
    <section className="circuit-reward" id="premio" aria-labelledby="premio-titulo">
      {shown === null ? (
        <>
          <h2 id="premio-titulo" ref={heading} tabIndex={-1}>
            Tu premio
          </h2>
          <p>Completaste el circuito: pide tu comprobante y muéstralo para recibir el premio.</p>
          <button
            type="button"
            className="portal-button"
            onClick={() => void ask(true)}
            disabled={busy}
          >
            {busy ? "Pidiendo…" : "Pedir mi premio"}
          </button>
        </>
      ) : shown.redeemedAt ? (
        <>
          <h2 id="premio-titulo" ref={heading} tabIndex={-1}>
            Premio recibido
          </h2>
          <p>
            Ya recibiste el premio de este circuito el {day(shown.redeemedAt)}. ¡Gracias por
            recorrerlo!
          </p>
        </>
      ) : (
        <>
          <h2 id="premio-titulo" ref={heading} tabIndex={-1}>
            Tu comprobante
          </h2>
          <p className="voucher-code">
            <span className="visually-hidden">Código: </span>
            {formatVoucherCode(shown.code)}
          </p>
          <p>
            Muéstralo para recibir: <strong>{shown.reward}</strong>
          </p>
          <p className="voucher-meta">
            Vale hasta el {day(shown.expiresAt)}
            {shown.stampsTotal > 0
              ? ` · ${shown.stampsTotal} sellos, ${shown.stampsLocated} con ubicación`
              : ""}
            . Se canjea una sola vez.
          </p>
        </>
      )}
      <p className="stamp-status" role="status" aria-live="polite">
        {busy && shown !== null ? "Revisando tu comprobante…" : message}
      </p>
    </section>
  );
}
