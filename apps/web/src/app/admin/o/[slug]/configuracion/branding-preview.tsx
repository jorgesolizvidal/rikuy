"use client";

import {
  deriveTheme,
  isHexColor,
  monogram,
  themeContrast,
  themeCssVariables,
  type ContrastCheck,
} from "@rikuy/core";
import type { CSSProperties } from "react";

import type { BrandingValues } from "./branding-fields";

const CHECK_LABELS: Readonly<Record<ContrastCheck, string>> = {
  brandOnBackground: "Color principal sobre el fondo",
  textOnBrand: "Texto de los botones",
  accentOnBackground: "Acento sobre el fondo",
};

const ratio = new Intl.NumberFormat("es-BO", { maximumFractionDigits: 1 });

/** Live preview of the portal header and hero with WCAG contrast checks. */
export function BrandingPreview({
  values,
  logoUrl,
}: {
  readonly values: BrandingValues;
  readonly logoUrl: string | null;
}) {
  const brand = values.brand.trim().toLowerCase();
  const accent = values.accent.trim().toLowerCase();
  const colorsValid = isHexColor(brand) && isHexColor(accent);
  const choice = { mode: values.mode, brand, accent };
  const palette = colorsValid ? deriveTheme(choice) : null;
  const checks = colorsValid ? themeContrast(choice) : [];
  const shortName = values.shortName.trim() || "?";

  return (
    <aside className="branding-preview" aria-labelledby="preview-title">
      <h2 id="preview-title">Vista previa</h2>
      {palette ? (
        <div
          className="preview-portal"
          style={themeCssVariables(palette) as CSSProperties}
          // Purely visual copy of what the form says; screen readers get the form itself.
          aria-hidden="true"
        >
          <div className="preview-header">
            {logoUrl ? (
              // Short-lived signed URL from Storage (see LogoField).
              // eslint-disable-next-line @next/next/no-img-element
              <img className="preview-logo" src={logoUrl} alt="" />
            ) : (
              <span className="preview-mark">{monogram(shortName)}</span>
            )}
            <span>{values.siteName || "Nombre del portal"}</span>
          </div>
          <p className="preview-title">{values.siteName || "Nombre del portal"}</p>
          {values.tagline ? <p className="preview-tagline">{values.tagline}</p> : null}
          <p className="preview-body">
            Texto de ejemplo con un <span className="preview-link">enlace</span>.
          </p>
          <span className="preview-button">Botón</span>
          <span className="preview-rule" />
        </div>
      ) : (
        <p className="notice">Escribe los colores en formato #rrggbb para ver la vista previa.</p>
      )}

      {checks.length > 0 ? (
        <ul className="contrast-list" aria-label="Contraste de colores (WCAG AA)">
          {checks.map((check) => (
            <li key={check.check} data-passes={check.passes}>
              <span aria-hidden="true">{check.passes ? "✓" : "✕"}</span>
              <span>
                {CHECK_LABELS[check.check]}: {ratio.format(check.ratio)}:1,{" "}
                {check.passes
                  ? "se lee bien"
                  : `insuficiente (mínimo ${ratio.format(check.minimum)}:1)`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  );
}
