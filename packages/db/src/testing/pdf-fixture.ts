/**
 * Minimal, valid PDF files for tests (no library): one Helvetica text page per entry, in
 * WinAnsi so Spanish accents survive. Lines are drawn top to bottom. `image` pages carry no
 * text at all (what a scanned document looks like to a text extractor).
 */

export type PdfPage = { readonly lines: readonly string[] } | { readonly image: true };

const encoder = new TextEncoder();

/** WinAnsi (≈ Latin-1 for Spanish) with PDF string escapes. */
function pdfString(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (char === "(" || char === ")" || char === "\\") out += `\\${char}`;
    else if (code >= 32 && code < 127) out += char;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += "?";
  }
  return `(${out})`;
}

function latin1(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

export function syntheticPdf(pages: readonly PdfPage[], options: { encrypted?: boolean } = {}) {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add("");
  const tree = add("");
  const font = add(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  const kids: number[] = [];
  for (const page of pages) {
    const content =
      "image" in page
        ? "q 200 0 0 200 100 400 cm 0.5 g 0 0 1 1 re f Q"
        : [
            "BT /F1 12 Tf 14 TL 72 760 Td",
            ...page.lines.map((line) => `${pdfString(line)} Tj T*`),
            "ET",
          ].join("\n");
    const stream = add(`<< /Length ${latin1(content).length} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const encrypt = options.encrypted
    ? add(
        "<< /Filter /Standard /V 1 /R 2 /O (0123456789abcdef0123456789abcdef) /U (0123456789abcdef0123456789abcdef) /P -4 >>",
      )
    : null;

  let body = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(latin1(body).length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = latin1(body).length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R` +
    (encrypt
      ? ` /Encrypt ${encrypt} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]`
      : "") +
    ` >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(body);
}

/** UTF-8 bytes of a text file. */
export function textFile(text: string): Uint8Array {
  return encoder.encode(text);
}
