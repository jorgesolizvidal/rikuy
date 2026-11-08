"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { startEvaluationAction } from "./actions";

const PROBLEMS: Readonly<Record<string, string>> = {
  forbidden: "Hace falta la verificación en dos pasos de operador.",
  invalid: "Elige dos demos distintas.",
  not_ready: "Las dos tienen que ser demos comerciales en línea, con su dirección del portal.",
  not_configured: "La IA no está configurada en este despliegue.",
  signed_out: "Tu sesión terminó: vuelve a entrar.",
  error: "No pudimos empezar la corrida. Inténtalo de nuevo.",
};

/** Starts a run: demo A (the one shown to clients) and, optionally, demo B (trap data). */
export function StartForm({
  suite,
  path,
  demos,
}: {
  readonly suite: string;
  readonly path: string;
  readonly demos: readonly { readonly tenantId: string; readonly displayName: string }[];
}) {
  const ids = useId();
  const router = useRouter();
  const [a, setA] = useState(demos[0]?.tenantId ?? "");
  const [b, setB] = useState(demos.find((demo) => demo.tenantId !== a)?.tenantId ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function start() {
    setMessage(null);
    startTransition(async () => {
      const result = await startEvaluationAction({ suite, tenantA: a, tenantB: b });
      if (result.status === "started" && "runId" in result) {
        router.push(`${path}?corrida=${result.runId}`);
        return;
      }
      setMessage(PROBLEMS[result.status] ?? PROBLEMS.error ?? "");
    });
  }

  return (
    <>
      <div className="invite-form">
        <div className="field">
          <label htmlFor={`${ids}-a`}>Demo A (la que ven los clientes)</label>
          <select
            id={`${ids}-a`}
            value={a}
            disabled={pending}
            onChange={(e) => setA(e.target.value)}
          >
            {demos.map((demo) => (
              <option key={demo.tenantId} value={demo.tenantId}>
                {demo.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${ids}-b`}>Demo B (datos de prueba)</label>
          <select
            id={`${ids}-b`}
            value={b}
            disabled={pending}
            onChange={(e) => setB(e.target.value)}
          >
            <option value="">Sin demo B</option>
            {demos
              .filter((demo) => demo.tenantId !== a)
              .map((demo) => (
                <option key={demo.tenantId} value={demo.tenantId}>
                  {demo.displayName}
                </option>
              ))}
          </select>
        </div>
        <button type="button" className="button" disabled={pending || a === ""} onClick={start}>
          {pending ? "Empezando…" : "Empezar una corrida"}
        </button>
      </div>
      <p className="field-error" role="status">
        {message ?? ""}
      </p>
    </>
  );
}
