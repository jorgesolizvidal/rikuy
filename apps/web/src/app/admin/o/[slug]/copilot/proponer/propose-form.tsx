"use client";

import {
  COPILOT_LIMITS,
  COPILOT_PATHS,
  PROPOSAL_FIELD_LABELS,
  PROPOSAL_STYLE_LABELS,
  PROPOSAL_STYLES,
  type ProposalField,
  type ProposalTarget,
} from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";

import { proposeAction, type ProposeState } from "../actions";

const MESSAGES: Partial<Record<ProposeState["status"], string>> = {
  invalid: "Elige al menos un campo y un tipo de pedido (y hasta 300 caracteres de detalle).",
  stale: "El contenido cambió mientras el Copilot escribía. Vuelve a pedir la propuesta.",
  not_found: "Ese contenido ya no existe o no es de este municipio.",
  forbidden: "Tu rol no permite pedir propuestas.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  error: "No pudimos pedir la propuesta. Prueba de nuevo en unos segundos.",
};

export function ProposeForm({
  org,
  target,
  fields,
  initial,
}: {
  readonly org: string;
  readonly target: ProposalTarget;
  readonly fields: readonly ProposalField[];
  readonly initial: readonly ProposalField[];
}) {
  const id = useId();
  const router = useRouter();
  const [state, action, pending] = useActionState(proposeAction, {
    status: "idle",
  } satisfies ProposeState);
  const [chosen, setChosen] = useState<ReadonlySet<ProposalField>>(new Set(initial));

  useEffect(() => {
    if (state.status === "created" && state.proposalId) {
      router.push(COPILOT_PATHS.proposal(org, state.proposalId));
    }
  }, [state, org, router]);

  const message = state.status === "notice" ? state.message : MESSAGES[state.status];
  return (
    <form action={action} className="form copilot-propose" aria-busy={pending}>
      <input type="hidden" name="org" value={org} />
      {target.type === "content" ? (
        <input type="hidden" name="contenido" value={target.contentId} />
      ) : (
        <>
          <input type="hidden" name="tour" value={target.tourId} />
          <input type="hidden" name="escena" value={target.sceneId} />
        </>
      )}
      <fieldset className="field">
        <legend>Campos</legend>
        {fields.map((field) => (
          <label key={field} className="checkbox">
            <input
              type="checkbox"
              name="fields"
              value={field}
              checked={chosen.has(field)}
              onChange={(event) => {
                const next = new Set(chosen);
                if (event.target.checked) next.add(field);
                else next.delete(field);
                setChosen(next);
              }}
            />
            {PROPOSAL_FIELD_LABELS[field]}
          </label>
        ))}
      </fieldset>
      <fieldset className="field">
        <legend>Pedido</legend>
        {PROPOSAL_STYLES.map((style, index) => (
          <label key={style} className="checkbox">
            <input type="radio" name="style" value={style} defaultChecked={index === 0} />
            {PROPOSAL_STYLE_LABELS[style]}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={`${id}-words`}>Detalle (opcional)</label>
        <input
          id={`${id}-words`}
          name="words"
          maxLength={COPILOT_LIMITS.instruction}
          aria-describedby={`${id}-words-hint`}
        />
        <span id={`${id}-words-hint`} className="field-hint">
          Por ejemplo, «menciona que es ideal para ir en familia». El Copilot no agrega datos que no
          estén escritos.
        </span>
      </div>
      <div className="form-actions">
        <button type="submit" className="button" disabled={pending || chosen.size === 0}>
          {pending ? "El Copilot está escribiendo…" : "Pedir la propuesta"}
        </button>
      </div>
      {message ? (
        <p className={state.status === "notice" ? "notice" : "field-error"} role="status">
          {message}
        </p>
      ) : null}
    </form>
  );
}
