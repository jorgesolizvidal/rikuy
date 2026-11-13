import { stampUrl, type StampCode } from "@rikuy/core";
import QRCode from "qrcode";

import { RenewStampCode } from "./renew-stamp-code";

const DATE = new Intl.DateTimeFormat("es-BO", {
  dateStyle: "medium",
  timeZone: "America/La_Paz",
});

/**
 * The stamp QR of every stop (ADR-057), to print and put at the place. It is another code
 * than the destination's (that one opens its page): this one stamps the passport. Generated
 * on the server like the other QR codes: black on white, medium correction, quiet zone.
 */
export async function StampCodes({
  org,
  codes,
  portalOrigin,
  portalOnline,
  canRenew,
}: {
  readonly org: string;
  readonly codes: readonly StampCode[];
  readonly portalOrigin: string | null;
  readonly portalOnline: boolean;
  readonly canRenew: boolean;
}) {
  const options = { errorCorrectionLevel: "M", margin: 4 } as const;
  const rendered = await Promise.all(
    codes.map(async (code) => {
      if (portalOrigin === null) return { code, svg: null, png: null };
      const url = stampUrl(portalOrigin, code.code);
      const [svg, png] = await Promise.all([
        QRCode.toString(url, { ...options, type: "svg" }),
        QRCode.toDataURL(url, { ...options, width: 1200 }),
      ]);
      return { code, svg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, png };
    }),
  );

  return (
    <section aria-labelledby="codigos-de-sello" className="stamp-codes-section">
      <h2 id="codigos-de-sello">Códigos de sello de cada lugar</h2>
      <p className="field-hint">
        Imprime el código de cada lugar y ponlo donde los visitantes lo vean. Al escanearlo, el
        visitante guarda el sello en su teléfono. Es otro código que el de la ficha del destino:
        este sella el pasaporte. Si alguien lo comparte para sellar sin ir, «Renovar el QR» hace que
        el impreso deje de sellar.
      </p>
      {portalOnline ? null : (
        <p className="field-hint">
          El portal aún no está en línea: los códigos sellarán cuando lo esté.
        </p>
      )}
      {codes.length === 0 ? (
        <p className="notice">Los lugares tendrán su código cuando los agregues a un circuito.</p>
      ) : (
        <ul className="stamp-codes">
          {rendered.map(({ code, svg, png }) => {
            const published = code.circuits.some((circuit) => circuit.status === "published");
            return (
              <li key={code.contentId} className="stamp-code">
                <h3>{code.title}</h3>
                <p className="cell-detail">
                  En {code.circuits.map((circuit) => `«${circuit.name}»`).join(", ")}
                </p>
                {!code.published ? (
                  <p className="field-hint">
                    El destino no está publicado: su código no sella hasta que lo esté.
                  </p>
                ) : !published ? (
                  <p className="field-hint">
                    Ningún circuito publicado lo tiene: su código no sella hasta que lo tenga.
                  </p>
                ) : null}
                {svg && png ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="qr"
                      src={svg}
                      width={140}
                      height={140}
                      alt={`Código QR de sello de «${code.title}»`}
                    />
                    <p className="qr-downloads">
                      <a href={png} download={`sello-${code.slug}-${code.version}.png`}>
                        Descargar PNG
                      </a>
                      <a href={svg} download={`sello-${code.slug}-${code.version}.svg`}>
                        Descargar SVG
                      </a>
                    </p>
                  </>
                ) : (
                  <p className="field-hint">El municipio todavía no tiene dirección del portal.</p>
                )}
                <p className="cell-detail">
                  {code.renewedAt
                    ? `Código n.º ${code.version}, renovado el ${DATE.format(new Date(code.renewedAt))}`
                    : `Código n.º 1, del ${DATE.format(new Date(code.createdAt))}`}
                </p>
                {canRenew ? (
                  <RenewStampCode
                    org={org}
                    contentId={code.contentId}
                    version={code.version}
                    title={code.title}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
