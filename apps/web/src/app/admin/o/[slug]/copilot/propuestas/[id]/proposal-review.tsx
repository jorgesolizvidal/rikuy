"use client";

import type { DiffPart, ProposalField, ProposalStatus } from "@rikuy/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { acceptProposalAction, rejectProposalAction, type DecideState } from "../../actions";

export interface FieldDiff {
  readonly field: ProposalField;
  readonly label: string;
  readonly multiline: boolean;
  readonly parts: readonly DiffPart[];
  /** The proposed value as the editor would show it. */
  readonly after: string;
}

const MESSAGES: Partial<Record<DecideState["status"], string>> = {
  stale:
    "El contenido cambió desde que se hizo esta propuesta, así que no se guardó nada. Pide una nueva propuesta sobre lo último guardado.",
  expired: "La propuesta venció (30 días). Pide una nueva.",
  decided: "Esta propuesta ya se decidió.",
  invalid: "Marca al menos un campo para guardar.",
  not_found: "La propuesta ya no existe.",
  forbidden: "Tu rol no permite decidir propuestas.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No pudimos guardar tu decisión. Prueba de nuevo en unos segundos.",
};

function Diff({
  parts,
  multiline,
}: {
  readonly parts: readonly DiffPart[];
  readonly multiline: boolean;
}) {
  return (
    <div className={multiline ? "copilot-diff copilot-diff-multiline" : "copilot-diff"}>
      {parts.map((part, index) =>
        part.kind === "same" ? (
          <span key={index}>{part.text}</span>
        ) : part.kind === "removed" ? (
          <del key={index}>
            <span className="visually-hidden">[se quita: </span>
            {part.text}
            <span className="visually-hidden">]</span>
          </del>
        ) : (
          <ins key={index}>
            <span className="visually-hidden">[se agrega: </span>
            {part.text}
            <span className="visually-hidden">]</span>
          </ins>
        ),
      )}
    </div>
  );
}

export function ProposalReview({
  org,
  proposalId,
  status,
  stale,
  acceptedFields,
  fields,
  editorHref,
  againHref,
}: {
  readonly org: string;
  readonly proposalId: string;
  readonly status: ProposalStatus;
  readonly stale: boolean;
  readonly acceptedFields: readonly ProposalField[] | null;
  readonly fields: readonly FieldDiff[];
  readonly editorHref: string;
  readonly againHref: string;
}) {
  const router = useRouter();
  const [accepted, accept, accepting] = useActionState(acceptProposalAction, {
    status: "idle",
  } satisfies DecideState);
  const [rejected, reject, rejecting] = useActionState(rejectProposalAction, {
    status: "idle",
  } satisfies DecideState);
  const [chosen, setChosen] = useState<ReadonlySet<ProposalField>>(
    new Set(fields.map((item) => item.field)),
  );
  const [showFull, setShowFull] = useState(false);

  useEffect(() => {
    if (accepted.status === "accepted" || rejected.status === "rejected") router.refresh();
  }, [accepted.status, rejected.status, router]);

  const decidable = status === "pending" && !stale;
  const last = rejected.status !== "idle" ? rejected : accepted;
  const message = MESSAGES[last.status];

  return (
    <>
      {status === "accepted" ? (
        <p className="form-success" role="status">
          Aceptada: se guardó como borrador (
          {(acceptedFields ?? [])
            .map((field) => fields.find((item) => item.field === field)?.label ?? field)
            .join(", ")}
          ). Revísalo y publícalo desde el editor. <Link href={editorHref}>Abrir en el editor</Link>
        </p>
      ) : status === "rejected" ? (
        <p className="notice" role="status">
          Rechazada: no se guardó nada.
        </p>
      ) : status === "expired" ? (
        <p className="notice" role="status">
          Venció sin decidirse. <Link href={againHref}>Pedir una nueva propuesta</Link>
        </p>
      ) : stale ? (
        <p className="notice" role="status">
          Desactualizada: el contenido cambió desde que se hizo esta propuesta, así que ya no se
          puede aceptar. <Link href={againHref}>Pedir una nueva propuesta</Link> sobre lo último
          guardado.
        </p>
      ) : null}

      <form action={accept} className="form copilot-review" aria-busy={accepting || rejecting}>
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="proposal" value={proposalId} />
        {fields.map((item) => (
          <fieldset key={item.field} className="copilot-change">
            <legend>{item.label}</legend>
            <Diff parts={item.parts} multiline={item.multiline} />
            {item.multiline ? (
              <details
                className="copilot-full"
                open={showFull}
                onToggle={(event) => setShowFull(event.currentTarget.open)}
              >
                <summary>Ver el texto propuesto completo</summary>
                <pre className="copilot-after">{item.after}</pre>
              </details>
            ) : null}
            {decidable ? (
              <label className="checkbox">
                <input
                  type="checkbox"
                  name="fields"
                  value={item.field}
                  checked={chosen.has(item.field)}
                  onChange={(event) => {
                    const next = new Set(chosen);
                    if (event.target.checked) next.add(item.field);
                    else next.delete(item.field);
                    setChosen(next);
                  }}
                />
                Guardar este cambio
              </label>
            ) : null}
          </fieldset>
        ))}
        {decidable ? (
          <div className="form-actions">
            <button
              type="submit"
              className="button"
              disabled={accepting || rejecting || chosen.size === 0}
            >
              {accepting ? "Guardando…" : "Aceptar lo marcado (borrador)"}
            </button>
            <button
              type="submit"
              formAction={reject}
              className="button button-quiet"
              disabled={accepting || rejecting}
            >
              {rejecting ? "Rechazando…" : "Rechazar"}
            </button>
          </div>
        ) : null}
        {message ? (
          <p className="field-error" role="status">
            {message}
          </p>
        ) : null}
      </form>
    </>
  );
}
