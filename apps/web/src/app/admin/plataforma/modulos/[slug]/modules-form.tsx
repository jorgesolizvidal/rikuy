"use client";

import { MODULE_NAMES, MODULES, type ModuleKey } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState, useTransition, type FormEvent } from "react";

import { changeModulesAction, type ModulesState } from "../actions";

const MESSAGES: Partial<Record<ModulesState["status"], string>> = {
  invalid: "No se pudo guardar: algún módulo no es válido. Recarga la página.",
  not_found: "Ese municipio ya no existe.",
  forbidden: "Tu sesión de operador ya no es válida. Recarga la página.",
  error: "No se pudo guardar. Inténtalo de nuevo en unos segundos.",
};

/**
 * The modules of one municipality (ADR-060): a checkbox each. A module that needs another one
 * is turned off with it and cannot be turned on alone. Turning one off asks first: its pages
 * leave the portal and the panel at once (nothing is deleted).
 */
export function ModulesForm({
  tenantId,
  displayName,
  current,
}: {
  readonly tenantId: string;
  readonly displayName: string;
  readonly current: readonly ModuleKey[];
}) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState(changeModulesAction, {
    status: "idle",
  } as ModulesState);
  const [, startTransition] = useTransition();
  const [chosen, setChosen] = useState<ReadonlySet<ModuleKey>>(() => new Set(current));
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (state.status === "updated") router.refresh();
  }, [state, router]);

  const turnedOff = MODULES.filter((m) => current.includes(m.key) && !chosen.has(m.key));
  const turnedOn = MODULES.filter((m) => !current.includes(m.key) && chosen.has(m.key));
  const changed = turnedOff.length + turnedOn.length > 0;

  function toggle(key: ModuleKey, on: boolean) {
    setConfirming(false);
    setChosen((previous) => {
      const next = new Set(previous);
      if (on) next.add(key);
      else {
        next.delete(key);
        // What needs it goes with it.
        for (const item of MODULES) if (item.requires === key) next.delete(item.key);
      }
      return next;
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (turnedOff.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    const formData = new FormData(event.currentTarget);
    setConfirming(false);
    startTransition(() => dispatch(formData));
  }

  return (
    <form className="form modules-form" onSubmit={submit} noValidate>
      <input type="hidden" name="tenantId" value={tenantId} />
      <fieldset className="field">
        <legend>Módulos de {displayName}</legend>
        <ul className="modules-list">
          {MODULES.map((item) => {
            const blocked = item.requires !== undefined && !chosen.has(item.requires);
            const id = `module-${item.key}`;
            return (
              <li key={item.key}>
                <label className="checkbox" htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    name="module"
                    value={item.key}
                    checked={chosen.has(item.key)}
                    disabled={blocked || pending}
                    aria-describedby={`${id}-hint`}
                    onChange={(event) => toggle(item.key, event.target.checked)}
                  />
                  <span className="org-name">{item.name}</span>
                </label>
                <p className="field-hint" id={`${id}-hint`}>
                  {item.description}
                  {item.requires ? ` Necesita «${MODULE_NAMES[item.requires]}».` : ""}
                </p>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {confirming ? (
        <div className="notice" role="alert">
          <p>
            Vas a apagar {turnedOff.map((m) => `«${m.name}»`).join(", ")}. Sus páginas dejan de
            verse en el portal y en el panel desde ahora; no se borra nada y vuelven como estaban si
            lo enciendes de nuevo.
          </p>
        </div>
      ) : null}
      {MESSAGES[state.status] ? (
        <p className="form-error" role="alert">
          {MESSAGES[state.status]}
        </p>
      ) : null}
      {state.status === "requires" && state.module && state.needs ? (
        <p className="form-error" role="alert">
          «{MODULE_NAMES[state.module]}» necesita «{MODULE_NAMES[state.needs]}».
        </p>
      ) : null}
      {state.status === "updated" && !changed ? (
        <p className="notice" role="status">
          Se guardaron los módulos. El portal los muestra en la siguiente visita.
        </p>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="button" disabled={pending || !changed}>
          {pending ? "Guardando…" : confirming ? "Sí, guardar los módulos" : "Guardar los módulos"}
        </button>
        {confirming ? (
          <button
            type="button"
            className="button button-quiet"
            onClick={() => setConfirming(false)}
          >
            Cancelar
          </button>
        ) : null}
      </div>
    </form>
  );
}
