import { describe, expect, it } from "vitest";

import { parsePersonRequest } from "./handoff";

const REF = "11111111-0000-4000-8000-000000000001";
const SCENE = "22222222-0000-4000-8000-000000000002";

describe("parsePersonRequest", () => {
  it("keeps the question masked, with its language and page", () => {
    expect(
      parsePersonRequest({
        ref: REF,
        question: "Hola, mi correo es ana@example.com. ¿Abre el domingo?",
        page: { kind: "destination", slug: "museo" },
      }),
    ).toEqual({
      requestId: REF,
      question: "mi correo es [correo]. ¿Abre el domingo?",
      lang: "es",
      page: { kind: "destination", slug: "museo" },
      sceneId: null,
    });
  });

  it("keeps the scene only inside a tour", () => {
    expect(
      parsePersonRequest({
        ref: REF,
        question: "What am I looking at?",
        page: { kind: "destination_tour", slug: "museo" },
        tour: { sceneId: SCENE, hotspotId: null },
      }),
    ).toMatchObject({ lang: "en", sceneId: SCENE });
    expect(
      parsePersonRequest({ ref: REF, question: "¿Qué es?", tour: { sceneId: SCENE } }),
    ).toMatchObject({ page: { kind: "other", slug: null }, sceneId: null });
  });

  it("refuses what is not a person request", () => {
    expect(parsePersonRequest(null)).toBeNull();
    expect(parsePersonRequest({ ref: "r1", question: "¿Abre?" })).toBeNull();
    expect(parsePersonRequest({ ref: REF, question: "x" })).toBeNull();
    expect(parsePersonRequest({ ref: REF, question: "Muchas gracias" })).toBeNull();
    expect(parsePersonRequest({ ref: REF, question: "a".repeat(501) })).toBeNull();
  });
});
