import type { Metadata } from "next";

/** The platform's own page is not a municipality's portal: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function HomePage() {
  return (
    <main className="shell">
      <p className="eyebrow">Rikuy · quechua: «ver, mirar»</p>
      <h1 className="title">Rikuy</h1>
      <p className="lead">
        Plataforma de turismo inmersivo para municipios: tours 360°, modelos 3D, mapas y una guía
        con IA, cada municipio con su propia marca.
      </p>
      <p className="status" role="status">
        <span className="dot" aria-hidden="true" />
        En construcción
      </p>
    </main>
  );
}
