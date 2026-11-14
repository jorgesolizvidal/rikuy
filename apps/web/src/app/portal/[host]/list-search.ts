/** Lowercase, without accents: «Iglesia» matches «iglésia» and «IGLESIA» (ADR-062). */
export function searchText(...parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLocaleLowerCase("es");
}
