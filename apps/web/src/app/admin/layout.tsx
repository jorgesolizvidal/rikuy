import "./admin.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: { default: "Administración · Rikuy", template: "%s · Rikuy" },
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="admin">
      <a className="admin-skip" href="#contenido">
        Saltar al contenido
      </a>
      {children}
    </div>
  );
}
