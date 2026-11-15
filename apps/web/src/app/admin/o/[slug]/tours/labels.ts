/** Words shared by the tours pages. */
export const TOUR_STATUS = {
  draft: { label: "Borrador", detail: "Nunca publicado" },
  published: { label: "Publicado", detail: "Sin cambios pendientes" },
  changed: { label: "Con cambios", detail: "Publicado; los cambios todavía no se ven" },
} as const;

export const KIND = {
  destination: { label: "Destino", path: "destinos" },
  event: { label: "Evento", path: "agenda" },
} as const;

export function scenesLabel(count: number): string {
  return count === 1 ? "1 escena" : `${count} escenas`;
}
