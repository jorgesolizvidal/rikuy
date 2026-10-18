import { describe, expect, it } from "vitest";

import { richTextSchema, richTextToPlainText, type RichText } from "../../contracts/rich-text";
import { parseMarkup, richTextToMarkup } from "./markup";

const text = (value: string, marks?: ("bold" | "italic")[]) =>
  marks ? { type: "text" as const, text: value, marks } : { type: "text" as const, text: value };

describe("writing format → rich text", () => {
  it("reads paragraphs, headings and lists", () => {
    const { blocks, problems } = parseMarkup(
      [
        "## Cómo llegar",
        "Sube por el camino",
        "desde la plaza.",
        "",
        "- Mejor hora: atardecer",
        "- Entrada libre",
        "",
        "### Horario",
        "1. Lunes a viernes",
        "2) Sábados",
      ].join("\r\n"),
    );
    expect(problems).toEqual([]);
    expect(blocks).toEqual([
      { type: "heading", level: 2, children: [text("Cómo llegar")] },
      { type: "paragraph", children: [text("Sube por el camino desde la plaza.")] },
      {
        type: "list",
        ordered: false,
        items: [[text("Mejor hora: atardecer")], [text("Entrada libre")]],
      },
      { type: "heading", level: 3, children: [text("Horario")] },
      { type: "list", ordered: true, items: [[text("Lunes a viernes")], [text("Sábados")]] },
    ]);
    expect(richTextSchema.safeParse(blocks).success).toBe(true);
  });

  it("reads bold, italic, both and https links", () => {
    const { blocks } = parseMarkup(
      "Lleva **agua** y *abrigo*, ***siempre***. Más en [la *guía* oficial](https://example.test/guía_(2026)).",
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [
          text("Lleva "),
          text("agua", ["bold"]),
          text(" y "),
          text("abrigo", ["italic"]),
          text(", "),
          text("siempre", ["bold", "italic"]),
          text(". Más en "),
          {
            type: "link",
            href: "https://example.test/guía_(2026)",
            children: [text("la "), text("guía", ["italic"]), text(" oficial")],
          },
          text("."),
        ],
      },
    ]);
  });

  it("keeps unpaired markers and escaped characters as text", () => {
    expect(parseMarkup("Precio: 5 * 2 = 10 \\*no cursiva\\* \\[sin enlace\\](x)").blocks).toEqual([
      { type: "paragraph", children: [text("Precio: 5 * 2 = 10 *no cursiva* [sin enlace](x)")] },
    ]);
    expect(parseMarkup("\\# no es título\n\n1\\. no es lista").blocks).toEqual([
      { type: "paragraph", children: [text("# no es título")] },
      { type: "paragraph", children: [text("1. no es lista")] },
    ]);
  });

  it("reports links that are not https (javascript:, http:, mailto:)", () => {
    const { blocks, problems } = parseMarkup(
      "Ver [esto](javascript:alert(1))\n\n[sitio](http://example.test) y [correo](mailto:a@b.test)",
    );
    expect(problems.map((problem) => [problem.line, problem.detail])).toEqual([
      [1, "javascript:alert(1)"],
      [3, "http://example.test"],
      [3, "mailto:a@b.test"],
    ]);
    // The label stays as plain text; no link is produced.
    expect(JSON.stringify(blocks)).not.toContain("javascript");
  });

  it("never lets HTML through: it is just text", () => {
    const { blocks } = parseMarkup('<img src=x onerror="alert(1)"><script>alert(1)</script>');
    expect(blocks).toEqual([
      {
        type: "paragraph",
        children: [text('<img src=x onerror="alert(1)"><script>alert(1)</script>')],
      },
    ]);
  });

  it("drops control characters and empty input", () => {
    expect(parseMarkup("a\u0000b\u0007c\tfin").blocks).toEqual([
      { type: "paragraph", children: [text("abc fin")] },
    ]);
    expect(parseMarkup("  \n\n  ").blocks).toEqual([]);
  });
});

describe("lists written without a space after the dash", () => {
  it("reads -Item as a list item, but keeps -5 °C as a paragraph", () => {
    expect(parseMarkup("-Naturaleza\n-Historia viva\n•Comida").blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [[text("Naturaleza")], [text("Historia viva")], [text("Comida")]],
      },
    ]);
    expect(parseMarkup("-5 °C en invierno").blocks).toEqual([
      { type: "paragraph", children: [text("-5 °C en invierno")] },
    ]);
  });
});

describe("rich text → writing format", () => {
  const samples: RichText[] = [
    [
      { type: "heading", level: 2, children: [text("Historia")] },
      {
        type: "paragraph",
        children: [
          text("Texto con "),
          text("negrita", ["bold"]),
          text(", "),
          text("ambas", ["bold", "italic"]),
          text(" y símbolos * [ ] \\ "),
          { type: "link", href: "https://example.test/a(b", children: [text("enlace raro")] },
        ],
      },
      { type: "list", ordered: true, items: [[text("uno")], [text("dos", ["italic"])]] },
      { type: "paragraph", children: [text("# parece título")] },
      { type: "paragraph", children: [text("- parece lista")] },
      { type: "paragraph", children: [text("-parece lista sin espacio")] },
      { type: "paragraph", children: [text("-5 °C en invierno")] },
      { type: "paragraph", children: [text("3. parece numerada")] },
    ],
  ];

  it("round-trips: what the editor shows parses back to the same document", () => {
    for (const blocks of samples) {
      const markup = richTextToMarkup(blocks);
      const reparsed = parseMarkup(markup);
      expect(reparsed.problems).toEqual([]);
      // Hrefs with unbalanced parentheses are percent-encoded (same URL).
      expect(JSON.stringify(reparsed.blocks)).toBe(
        JSON.stringify(blocks).replace("https://example.test/a(b", "https://example.test/a%28b"),
      );
    }
  });

  it("gives plain text for search and the assistant", () => {
    expect(richTextToPlainText(samples[0] ?? [])).toContain("• uno\n• dos");
  });
});

describe("rich text limits", () => {
  it("rejects documents beyond 20 000 visible characters", () => {
    const long = Array.from({ length: 5 }, () => ({
      type: "paragraph" as const,
      children: [text("x".repeat(4500))],
    }));
    expect(richTextSchema.safeParse(long).success).toBe(false);
    expect(richTextSchema.safeParse(long.slice(0, 4)).success).toBe(true);
  });

  it("rejects unknown nodes and attributes", () => {
    expect(richTextSchema.safeParse([{ type: "html", value: "<b>" }]).success).toBe(false);
    expect(
      richTextSchema.safeParse([
        { type: "paragraph", children: [{ ...text("a"), style: "color:red" }] },
      ]).success,
    ).toBe(false);
  });
});
