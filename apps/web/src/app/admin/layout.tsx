import "./admin.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { preload } from "react-dom";

import { THEME_FONTS, themeFontFaces } from "@/lib/theme-fonts";

export const metadata: Metadata = {
  title: { default: "Administración · Rikuy", template: "%s · Rikuy" },
  robots: { index: false, follow: false },
};

/**
 * The panel with Rikuy's own look (C3 · Paso 7, ADR-066): the «Editorial» theme's font and a
 * neutral palette (admin.css), the same for every municipality. A municipality's brand is seen
 * only in its preview and in its portal.
 */
export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  preload(THEME_FONTS.editorial.href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  return (
    <div className="admin">
      <style href="rikuy-font-editorial" precedence="default">
        {themeFontFaces("editorial")}
      </style>
      <a className="admin-skip" href="#contenido">
        Saltar al contenido
      </a>
      {children}
    </div>
  );
}
