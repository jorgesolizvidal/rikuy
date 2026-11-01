import { describe, expect, it } from "vitest";

import type { KnowledgePassage } from "../../contracts/knowledge";
import { chunkUnits, CHUNK_SIZE, richTextBlocks, sentences, type ChunkUnit } from "./chunker";
import { validateCitations } from "./citations";
import { contentUnits, tourUnits } from "./sources";
import { decodeTextFile, splitTextPages, textBlocks } from "./text";

const SECTION = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.";

describe("text files", () => {
  it("decodes UTF-8 (with BOM) and falls back to Windows-1252", () => {
    const utf8 = new TextEncoder().encode("﻿Ucureña, 1953");
    expect(decodeTextFile(utf8)).toEqual({ text: "Ucureña, 1953", encoding: "utf-8" });
    const latin = new Uint8Array([0x55, 0x63, 0x75, 0x72, 0x65, 0xf1, 0x61]);
    expect(decodeTextFile(latin)).toEqual({ text: "Ucureña", encoding: "windows-1252" });
  });

  it("refuses binary files whatever their name says", () => {
    expect(decodeTextFile(new TextEncoder().encode("%PDF-1.7 …"))).toBeNull();
    expect(decodeTextFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBeNull();
    expect(decodeTextFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(decodeTextFile(new Uint8Array([0x61, 0x00, 0x62]))).toBeNull();
    expect(decodeTextFile(new Uint8Array([]))).toBeNull();
  });

  it("uses printed page numbers as pages, fixing garbled ones from the sequence", () => {
    const text = [
      "Uno.",
      "14 | ",
      "Dos.",
      " | 15",
      "Tres.",
      "16 | ",
      "Cuatro.",
      " | 21",
      "Cinco.",
    ].join("\n");
    expect(splitTextPages(text)).toEqual([
      { page: 14, text: "Uno." },
      { page: 15, text: "Dos." },
      { page: 16, text: "Tres." },
      { page: 17, text: "Cuatro." },
      { page: 18, text: "Cinco." },
    ]);
  });

  it("has no pages with fewer than three marks; page feeds also split pages", () => {
    expect(splitTextPages("Uno.\n14 |\nDos.")).toEqual([{ page: null, text: "Uno.\n14 |\nDos." }]);
    expect(splitTextPages("Uno.\fDos.\f")).toEqual([
      { page: 1, text: "Uno." },
      { page: 2, text: "Dos." },
    ]);
  });
});

describe("blocks", () => {
  it("rejoins hard-wrapped lines and words cut with a hyphen", () => {
    const blocks = textBlocks([
      { page: 3, text: "La organi-\nzación sindical de los\ncampesinos creció." },
    ]);
    expect(blocks).toEqual([
      {
        type: "paragraph",
        text: "La organización sindical de los campesinos creció.",
        pageFrom: 3,
        pageTo: 3,
      },
    ]);
  });

  it("finds numbered and uppercase headings, also on two lines", () => {
    const blocks = textBlocks([
      {
        page: 1,
        text: "2.3. LA CH'AMPA GUERRA,\nCONFLICTO ENTRE DOS PUEBLOS.\nEl conflicto empezó en 1959 y\nduró varios años.",
      },
    ]);
    expect(blocks.map((block) => [block.type, block.text])).toEqual([
      ["heading", "2.3. LA CH'AMPA GUERRA, CONFLICTO ENTRE DOS PUEBLOS"],
      ["paragraph", "El conflicto empezó en 1959 y duró varios años."],
    ]);
  });

  it("drops page numbers and running headers, and keeps the page span of a paragraph", () => {
    const page = (number: number, text: string) => ({
      page: number,
      text: `Historia del valle\n${text}\n${number}`,
    });
    const blocks = textBlocks([
      page(1, "Primera parte de una idea que"),
      page(2, "sigue aquí."),
      page(3, "Otra idea."),
      page(4, "Final."),
    ]);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      text: "Primera parte de una idea que sigue aquí.",
      pageFrom: 1,
      pageTo: 2,
    });
    expect(blocks.some((block) => block.text.includes("Historia del valle"))).toBe(false);
  });
});

describe("chunks", () => {
  const unit = (blocks: ChunkUnit["blocks"], heading: string | null = null): ChunkUnit => ({
    heading,
    sceneId: null,
    hotspotId: null,
    blocks,
  });
  const para = (text: string, page: number | null = null) => ({
    type: "paragraph" as const,
    text,
    pageFrom: page,
    pageTo: page,
  });

  it("keeps sentences with abbreviations together", () => {
    expect(
      sentences("El Dr. Pérez llegó en 1953. Ver pág. 14 del libro. ¿Y después? Nada."),
    ).toEqual(["El Dr. Pérez llegó en 1953.", "Ver pág. 14 del libro.", "¿Y después?", "Nada."]);
  });

  it("packs paragraphs up to the target, never past the maximum, and never mixes sections", () => {
    const paragraphs = Array.from({ length: 40 }, (_, index) =>
      para(`${index}. ${SECTION}`, index + 1),
    );
    const chunks = chunkUnits([
      unit([{ type: "heading", text: "Uno", pageFrom: 1, pageTo: 1 }, ...paragraphs.slice(0, 20)]),
      unit([{ type: "heading", text: "Dos", pageFrom: 1, pageTo: 1 }, ...paragraphs.slice(20)]),
    ]);
    expect(chunks.every((chunk) => chunk.body.length <= CHUNK_SIZE.max)).toBe(true);
    expect(chunks.every((chunk) => chunk.body.length <= CHUNK_SIZE.target + 200)).toBe(true);
    expect(new Set(chunks.map((chunk) => chunk.heading))).toEqual(new Set(["Uno", "Dos"]));
    expect(chunks.map((chunk) => chunk.chunkNo)).toEqual(chunks.map((_, index) => index));
    expect(chunks[0]?.pageFrom).toBe(1);
    expect(chunks.at(-1)?.pageTo).toBe(40);
  });

  it("splits a long paragraph by sentences, repeating the last one in the next fragment", () => {
    const long = Array.from(
      { length: 80 },
      (_, index) => `Oración número ${index} del texto largo.`,
    ).join(" ");
    const chunks = chunkUnits([unit([para(long, 7)])]);
    expect(chunks.length).toBeGreaterThan(1);
    const lastOfFirst = sentences(chunks[0]?.body ?? "").at(-1);
    expect(chunks[1]?.body.startsWith(lastOfFirst ?? "∅")).toBe(true);
    expect(chunks.every((chunk) => chunk.pageFrom === 7 && chunk.pageTo === 7)).toBe(true);
  });

  it("cuts a sentence with no end between words", () => {
    const chunks = chunkUnits([unit([para("palabra ".repeat(800).trim())])]);
    expect(chunks.every((chunk) => chunk.body.length <= CHUNK_SIZE.max)).toBe(true);
    expect(
      chunks
        .map((chunk) => chunk.body)
        .join(" ")
        .split(" ").length,
    ).toBeGreaterThanOrEqual(800);
  });

  it("joins a short tail to the previous fragment of the same section", () => {
    const chunks = chunkUnits([unit([para("a".repeat(1400)), para("Breve.")])]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.body.endsWith("Breve.")).toBe(true);
  });

  it("is deterministic", () => {
    const input = [unit([para(SECTION.repeat(40), 2)], "Sala")];
    expect(chunkUnits(input)).toEqual(chunkUnits(input));
  });
});

describe("sources", () => {
  const base = {
    source: "content" as const,
    slug: "x",
    revisionNo: 2,
    title: "Feria del valle",
    summary: "Resumen.",
    body: [{ type: "paragraph" as const, children: [{ type: "text" as const, text: "Cuerpo." }] }],
    timezone: "America/La_Paz",
    venueTitle: "Plaza principal",
    document: null,
  };

  it("an event says its date and place in words", () => {
    const units = contentUnits(
      {
        ...base,
        kind: "event",
        schedule: { allDay: false, start: "2026-11-07T19:00", end: "2026-11-07T22:00" },
      },
      null,
    );
    expect(units[0]?.blocks.map((block) => block.text)).toEqual([
      "Resumen.",
      "Fecha: Sábado, 7 de noviembre de 2026, 19:00–22:00. Lugar: Plaza principal.",
      "Cuerpo.",
    ]);
  });

  it("a knowledge item adds its document's text with its pages", () => {
    const units = contentUnits(
      { ...base, kind: "knowledge", schedule: null, venueTitle: null },
      {
        version: 1,
        pages: [{ page: 9, text: "Texto del libro." }],
      },
    );
    expect(units[0]?.blocks.at(-1)).toEqual({
      type: "paragraph",
      text: "Texto del libro.",
      pageFrom: 9,
      pageTo: 9,
    });
  });

  it("a tour gives one unit per scene and per point with text", () => {
    const scene = "00000000-0000-4000-8000-000000000001";
    const point = "00000000-0000-4000-8000-000000000002";
    const units = tourUnits({
      source: "tour",
      kind: "destination",
      slug: "museo",
      revisionNo: 1,
      title: "Museo",
      manifest: {
        scenes: [
          {
            sceneId: scene,
            title: "Sala principal",
            description: "La sala más grande.",
            hotspots: [
              { hotspotId: point, kind: "info", title: "El horno", body: base.body },
              { hotspotId: point, kind: "scene", title: "Ir", body: [] },
            ],
          },
        ],
      } as never,
    });
    expect(units.map((u) => [u.heading, u.sceneId, u.hotspotId])).toEqual([
      ["Sala principal", scene, null],
      ["Sala principal · El horno", scene, point],
    ]);
  });

  it("rich text lists become one paragraph of bullet lines", () => {
    expect(
      richTextBlocks([
        { type: "heading", level: 2, children: [{ type: "text", text: "Horario" }] },
        {
          type: "list",
          ordered: false,
          items: [[{ type: "text", text: "Lunes" }], [{ type: "text", text: "Martes" }]],
        },
      ]).map((block) => [block.type, block.text]),
    ).toEqual([
      ["heading", "Horario"],
      ["paragraph", "• Lunes\n• Martes"],
    ]);
  });
});

describe("citations", () => {
  const passage: KnowledgePassage = {
    chunkId: "00000000-0000-4000-8000-0000000000c1",
    source: "content",
    sourceId: "00000000-0000-4000-8000-0000000000a1",
    sourceVersion: 3,
    kind: "knowledge",
    slug: "libro",
    title: "Libro",
    heading: null,
    text: "…",
    pages: { from: 14, to: 15 },
    sceneId: null,
    hotspotId: null,
    ended: false,
    score: 2,
  };
  const cite = (overrides: Record<string, unknown> = {}) => ({
    source: "content",
    sourceId: passage.sourceId,
    sourceVersion: 3,
    chunkId: passage.chunkId,
    ...overrides,
  });

  it("keeps only citations of retrieved passages, exactly, once", () => {
    const result = validateCitations(
      [
        cite(),
        cite(),
        cite({ sourceVersion: 2 }),
        cite({ source: "tour" }),
        cite({ chunkId: "00000000-0000-4000-8000-0000000000c9" }),
        cite({ sourceId: "00000000-0000-4000-8000-0000000000b1" }),
        { chunkId: passage.chunkId },
        "texto",
      ],
      [passage],
    );
    expect(result.valid).toEqual([passage]);
    expect(result.invalid).toBe(6);
  });
});
