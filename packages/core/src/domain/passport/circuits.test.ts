import { describe, expect, it } from "vitest";

import { circuitPublishIssues, isCircuitSlug, parseCircuitDraft } from "./circuits";

const A = "11111111-0000-4000-8000-000000000001";
const B = "11111111-0000-4000-8000-000000000002";

describe("parseCircuitDraft", () => {
  it("trims the fields and keeps the stops in their order", () => {
    expect(
      parseCircuitDraft({ name: "  Ruta  ", summary: " Corta ", reward: "", stops: [B, A] }),
    ).toEqual({ ok: true, value: { name: "Ruta", summary: "Corta", reward: "", stops: [B, A] } });
  });

  it("refuses an empty name, line breaks, long texts and repeated or invalid stops", () => {
    const result = parseCircuitDraft({
      name: " ",
      summary: "dos\nlíneas",
      reward: "x".repeat(201),
      stops: [A, A],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(["name", "reward", "stops", "summary"]);
    expect(parseCircuitDraft({ name: "R", summary: "", reward: "", stops: ["x"] })).toMatchObject({
      ok: false,
      errors: { stops: "Las paradas no son válidas." },
    });
    const many = Array.from(
      { length: 31 },
      (_, index) => `11111111-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    expect(parseCircuitDraft({ name: "R", summary: "", reward: "", stops: many }).ok).toBe(false);
  });

  it("accepts the address format of the portal", () => {
    expect(isCircuitSlug("ruta-historica")).toBe(true);
    expect(isCircuitSlug("Ruta Histórica")).toBe(false);
    expect(isCircuitSlug("ruta--doble")).toBe(false);
  });
});

describe("circuitPublishIssues", () => {
  it("asks for two published destinations", () => {
    expect(circuitPublishIssues({ stops: [] })).toEqual([
      "Agrega al menos dos destinos publicados.",
    ]);
    expect(circuitPublishIssues({ stops: [{ published: true }, { published: false }] })).toEqual([
      "Agrega al menos un destino publicado más (hacen falta dos).",
    ]);
    expect(circuitPublishIssues({ stops: [{ published: true }, { published: true }] })).toEqual([]);
  });
});
