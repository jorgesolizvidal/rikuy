import { describe, expect, it } from "vitest";

import { createPdfTextReader } from "./pdf-text";
import { syntheticPdf } from "./testing/pdf-fixture";

describe("PDF text", () => {
  const reader = createPdfTextReader();

  it("reads every page's lines, accents included", async () => {
    const result = await reader.read(
      syntheticPdf([
        { lines: ["Historia de la Reforma Agraria (1953)", "El sindicato de Ucureña organizó a"] },
        { image: true },
        { lines: ["Página tres: niños y caña."] },
      ]),
      { maxPages: 10 },
    );
    expect(result).toEqual({
      status: "ok",
      pages: [
        {
          page: 1,
          text: "Historia de la Reforma Agraria (1953)\nEl sindicato de Ucureña organizó a",
        },
        { page: 2, text: "" },
        { page: 3, text: "Página tres: niños y caña." },
      ],
    });
  });

  it("reports a protected file, a damaged one and too many pages", async () => {
    expect(
      await reader.read(syntheticPdf([{ lines: ["x"] }], { encrypted: true }), { maxPages: 5 }),
    ).toEqual({
      status: "encrypted",
    });
    expect(await reader.read(new TextEncoder().encode("%PDF-1.4 roto"), { maxPages: 5 })).toEqual({
      status: "unreadable",
    });
    expect(
      await reader.read(syntheticPdf([{ lines: ["a"] }, { lines: ["b"] }]), { maxPages: 1 }),
    ).toEqual({ status: "too_many_pages" });
  });
});
