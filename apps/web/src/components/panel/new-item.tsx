import type { ReactNode } from "react";

/**
 * «Nuevo destino», «Nuevo evento»…: one button at the top of a list that opens its form
 * (C3 · Paso 8, ADR-067). Before, every list opened with its creation form, the same block
 * in five pages. It starts open when the list is empty (the first thing to do) or when the
 * address asks for it (`?nuevo`, from the quick actions of the municipality's home).
 */
export function NewItem({
  label,
  open,
  children,
}: {
  readonly label: string;
  readonly open: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details className="panel-new" open={open}>
      <summary className="button">
        <span aria-hidden="true">+</span> {label}
      </summary>
      <div className="panel-new-body">{children}</div>
    </details>
  );
}

/** `?nuevo` in the page's address. */
export function wantsNew(search: { readonly nuevo?: string | string[] | undefined }): boolean {
  return search.nuevo !== undefined;
}
