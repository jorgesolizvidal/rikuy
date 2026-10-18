import QRCode from "qrcode";

/**
 * Where visitors see the destination, with a QR code for signs on site. Generated on the
 * server from the canonical portal address: black on white, medium error correction and a
 * quiet zone so it scans from a printed sign. PNG for quick printing, SVG for designers.
 */
export async function PortalShare({
  url,
  slug,
  title,
  portalOnline,
}: {
  readonly url: string;
  readonly slug: string;
  readonly title: string;
  readonly portalOnline: boolean;
}) {
  const options = { errorCorrectionLevel: "M", margin: 4 } as const;
  const [svg, png] = await Promise.all([
    QRCode.toString(url, { ...options, type: "svg" }),
    QRCode.toDataURL(url, { ...options, width: 1200 }),
  ]);
  const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  return (
    <section className="portal-share" aria-labelledby="para-visitantes">
      <h2 id="para-visitantes">Para visitantes</h2>
      <p>
        <a href={url} target="_blank" rel="noopener noreferrer">
          Ver en el portal<span className="visually-hidden"> (se abre en otra pestaña)</span>
        </a>
      </p>
      <p className="cell-detail portal-share-url">{url}</p>
      {portalOnline ? null : (
        <p className="field-hint">
          El portal aún no está en línea: el enlace y el código funcionarán cuando lo esté.
        </p>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="qr" src={svgUrl} width={160} height={160} alt={`Código QR de «${title}»`} />
      <p className="field-hint">
        Imprímelo en carteles del lugar: al escanearlo se abre esta ficha.
      </p>
      <p className="qr-downloads">
        <a href={png} download={`qr-${slug}.png`}>
          Descargar PNG
        </a>
        <a href={svgUrl} download={`qr-${slug}.svg`}>
          Descargar SVG
        </a>
      </p>
    </section>
  );
}
