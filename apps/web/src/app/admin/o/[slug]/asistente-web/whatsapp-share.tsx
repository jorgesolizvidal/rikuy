import { whatsappChatHref, type WhatsAppNumber } from "@rikuy/core";
import QRCode from "qrcode";

/**
 * «El asistente en WhatsApp» (ADR-075): the municipality's numbers, with a wa.me link and a
 * QR code for signs (black on white, like the others). The platform operator registers them.
 */
export async function WhatsAppShare({
  numbers,
  fileName,
}: {
  readonly numbers: readonly WhatsAppNumber[];
  readonly fileName: string;
}) {
  const shown = await Promise.all(
    numbers
      .filter((number) => number.displayPhone !== null)
      .map(async (number) => {
        const url = whatsappChatHref(number.displayPhone as string);
        const options = { errorCorrectionLevel: "M", margin: 4 } as const;
        const [svg, png] = await Promise.all([
          QRCode.toString(url, { ...options, type: "svg" }),
          QRCode.toDataURL(url, { ...options, width: 1200 }),
        ]);
        return {
          number,
          url,
          png,
          svgUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        };
      }),
  );

  return (
    <section aria-labelledby="whatsapp" className="embed-section">
      <h2 id="whatsapp">El asistente en WhatsApp</h2>
      {numbers.length === 0 ? (
        <p className="notice">
          Todavía no tiene un número. El operador de Rikuy registra el número de WhatsApp del
          municipio; los mensajes que lleguen a él los responde el asistente.
        </p>
      ) : (
        <>
          <p className="field-hint">
            Responde con lo mismo que el portal: textos, notas de voz y la ubicación que el
            visitante comparta («¿Qué hay cerca?»). Las conversaciones se olvidan a las 24 horas.
          </p>
          {numbers.some((number) => number.displayPhone === null) ? (
            <p className="field-hint">
              Un número sin el número a la vista no tiene código QR: pídele al operador que lo
              escriba.
            </p>
          ) : null}
          {shown.map(({ number, url, png, svgUrl }, index) => (
            <div key={number.phoneNumberId} className="portal-share">
              <p>
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {number.displayPhone}
                  <span className="visually-hidden"> (se abre en otra pestaña)</span>
                </a>
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="qr"
                src={svgUrl}
                width={160}
                height={160}
                alt={`Código QR de WhatsApp ${number.displayPhone}`}
              />
              <p className="qr-downloads">
                <a href={png} download={`${fileName}-${index + 1}.png`}>
                  Descargar PNG
                </a>
                <a href={svgUrl} download={`${fileName}-${index + 1}.svg`}>
                  Descargar SVG
                </a>
              </p>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
