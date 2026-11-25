import QRCode from "qrcode";

/**
 * «Pregúntale a …» (ADR-071): the assistant's own page, about this place or about the whole
 * municipality, with a QR code for signs. Black on white, medium error correction and a quiet
 * zone so it scans from print; PNG for quick printing, SVG for designers.
 */
export async function AskShare({
  url,
  fileName,
  assistantName,
  about,
  online,
}: {
  readonly url: string;
  readonly fileName: string;
  /** «Chaski», or null when the brand gives the assistant no name. */
  readonly assistantName: string | null;
  /** «este lugar», «este evento», or null for the whole municipality. */
  readonly about: string | null;
  readonly online: boolean;
}) {
  const options = { errorCorrectionLevel: "M", margin: 4 } as const;
  const [svg, png] = await Promise.all([
    QRCode.toString(url, { ...options, type: "svg" }),
    QRCode.toDataURL(url, { ...options, width: 1200 }),
  ]);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const title = assistantName ? `Pregúntale a ${assistantName}` : "Pregúntale al asistente";

  return (
    <section className="portal-share" aria-label={title}>
      <h2>«{title}»</h2>
      <p className="field-hint">
        {about
          ? `Abre el asistente ya listo para responder sobre ${about}, con o sin portal.`
          : "Abre el asistente del municipio, con o sin portal."}
      </p>
      <p>
        <a href={url} target="_blank" rel="noopener noreferrer">
          Abrir el asistente<span className="visually-hidden"> (se abre en otra pestaña)</span>
        </a>
      </p>
      <p className="cell-detail portal-share-url">{url}</p>
      {online ? null : (
        <p className="field-hint">
          El municipio aún no está en línea: el enlace y el código funcionarán cuando lo esté.
        </p>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="qr" src={svgUrl} width={160} height={160} alt={`Código QR «${title}»`} />
      <p className="qr-downloads">
        <a href={png} download={`${fileName}.png`}>
          Descargar PNG
        </a>
        <a href={svgUrl} download={`${fileName}.svg`}>
          Descargar SVG
        </a>
      </p>
    </section>
  );
}
