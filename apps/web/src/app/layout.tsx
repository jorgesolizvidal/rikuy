import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Rikuy",
  description:
    "Plataforma de turismo inmersivo para municipios: tours 360°, modelos 3D, mapas y guía con IA.",
  // No robots here: portals are indexable by default and their 404 page carries only Next's
  // own noindex. The platform page and the admin set noindex themselves.
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#14120f" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
