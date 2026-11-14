"use client";

import type { CategoryKind } from "@rikuy/core";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { saveCategoriesAction, type SaveCategoriesState } from "./actions";

interface Row {
  /** Local key; `id` is the saved category's, absent for a new one. */
  readonly key: string;
  readonly id?: string;
  readonly name: string;
  readonly used: number;
}

const MESSAGES: Readonly<Record<SaveCategoriesState["status"], string>> = {
  idle: "",
  saved: "Guardado. El portal ya filtra con estas categorías.",
  duplicate: "Hay dos categorías con el mismo nombre.",
  invalid: "Escribe cada nombre en una línea, hasta 40 caracteres (como mucho 20 categorías).",
  forbidden: "Solo los propietarios y administradores cambian las categorías.",
  signed_out: "Tu sesión terminó. Vuelve a iniciar sesión.",
  error: "No pudimos guardar. Inténtalo de nuevo.",
};

/** The categories of one kind: rename, reorder, add and remove; saved as one list. */
export function CategoryList({
  org,
  kind,
  initial,
  canManage,
  noun,
}: {
  readonly org: string;
  readonly kind: CategoryKind;
  readonly initial: readonly {
    readonly id: string;
    readonly name: string;
    readonly used: number;
  }[];
  readonly canManage: boolean;
  /** «destino» / «evento», for the counts. */
  readonly noun: readonly [string, string];
}) {
  const id = useId();
  const router = useRouter();
  const [rows, setRows] = useState<readonly Row[]>(
    initial.map((category) => ({ key: category.id, ...category })),
  );
  const [state, setState] = useState<SaveCategoriesState>({ status: "idle" });
  const [pending, startTransition] = useTransition();
  const [added, setAdded] = useState(0);

  const update = (next: readonly Row[]) => {
    setRows(next);
    setState({ status: "idle" });
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (row) next.splice(index + by, 0, row);
    update(next);
  };

  if (!canManage) {
    return rows.length === 0 ? (
      <p className="field-hint">Todavía no hay categorías.</p>
    ) : (
      <ul className="category-read">
        {rows.map((row) => (
          <li key={row.key}>
            {row.name}{" "}
            <span className="field-hint">
              ({row.used} {row.used === 1 ? noun[0] : noun[1]})
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <form
      className="form category-form"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await saveCategoriesAction({
            org,
            kind,
            categories: rows.map((row) =>
              row.id === undefined ? { name: row.name } : { id: row.id, name: row.name },
            ),
          });
          setState(result);
          if (result.status === "saved") router.refresh();
        });
      }}
    >
      {rows.length === 0 ? <p className="field-hint">Todavía no hay categorías.</p> : null}
      <ol className="category-rows">
        {rows.map((row, index) => (
          <li key={row.key} className="category-row">
            <label htmlFor={`${id}-${row.key}`} className="visually-hidden">
              Nombre de la categoría {index + 1}
            </label>
            <input
              id={`${id}-${row.key}`}
              value={row.name}
              maxLength={40}
              required
              aria-invalid={state.status === "invalid" && state.index === index ? true : undefined}
              onChange={(event) =>
                update(
                  rows.map((item, at) =>
                    at === index ? { ...item, name: event.target.value } : item,
                  ),
                )
              }
            />
            <span className="field-hint category-used">
              {row.id === undefined
                ? "Nueva"
                : `${String(row.used)} ${row.used === 1 ? noun[0] : noun[1]}`}
            </span>
            <span className="category-actions">
              <button
                type="button"
                className="button button-quiet"
                disabled={index === 0}
                aria-label={`Subir «${row.name || "sin nombre"}»`}
                onClick={() => move(index, -1)}
              >
                Subir
              </button>
              <button
                type="button"
                className="button button-quiet"
                disabled={index === rows.length - 1}
                aria-label={`Bajar «${row.name || "sin nombre"}»`}
                onClick={() => move(index, 1)}
              >
                Bajar
              </button>
              <button
                type="button"
                className="button button-quiet"
                aria-label={`Quitar «${row.name || "sin nombre"}»`}
                onClick={() => update(rows.filter((_, at) => at !== index))}
              >
                Quitar
              </button>
            </span>
          </li>
        ))}
      </ol>
      <div className="form-actions">
        <button
          type="button"
          className="button button-quiet"
          disabled={rows.length >= 20}
          onClick={() => {
            setAdded((count) => count + 1);
            update([...rows, { key: `nueva-${String(added)}`, name: "", used: 0 }]);
          }}
        >
          Agregar una categoría
        </button>
        <button type="submit" className="button" disabled={pending}>
          {pending ? "Guardando…" : "Guardar"}
        </button>
      </div>
      <p
        className={
          state.status === "saved" || state.status === "idle" ? "field-hint" : "field-error"
        }
        role="status"
      >
        {state.status === "duplicate" && state.name
          ? `Hay dos categorías llamadas «${state.name}».`
          : MESSAGES[state.status]}
      </p>
    </form>
  );
}
