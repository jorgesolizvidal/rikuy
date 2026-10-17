import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Administración · Rikuy",
  robots: { index: false, follow: false },
};

export default function AdminHomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">Rikuy · panel central</p>
      <h1 className="title">Administración</h1>
      <p className="lead">
        Desde aquí cada municipio gestionará su portal: marca, contenidos, tours y medios. El acceso
        con cuenta llega en el siguiente paso.
      </p>
      <p className="status" role="status">
        <span className="dot" aria-hidden="true" />
        Próximamente
      </p>
    </main>
  );
}
