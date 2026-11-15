/**
 * Small icons for the panel's repeated row actions (C3 · Paso 8, ADR-067): «Subir», «Bajar»
 * and «Quitar» in every list read as one word per row and crowded the rows. The button keeps
 * its accessible name (its `aria-label`, or the hidden words next to the icon) and a tooltip.
 */

const PATHS = {
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  remove: "M6 6l12 12M18 6 6 18",
} as const;

export type PanelIconName = keyof typeof PATHS;

export function PanelIcon({ name }: { readonly name: PanelIconName }) {
  return (
    <svg
      className="panel-icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
