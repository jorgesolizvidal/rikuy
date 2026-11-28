import { describe, expect, it } from "vitest";

import { assistantActionOf, parseAssistantAction } from "./turns";

const REF = "5eed7000-0000-4000-8000-000000000001";

describe("what a link inside an answer leads to (ADR-074)", () => {
  it("classifies portal paths", () => {
    expect(assistantActionOf("/destinos/museo")).toEqual({
      action: "place",
      key: "destination:museo",
    });
    expect(assistantActionOf("/agenda/feria")).toEqual({ action: "place", key: "event:feria" });
    expect(assistantActionOf("/servicios#cajero-central")).toEqual({
      action: "place",
      key: "service:cajero-central",
    });
    expect(assistantActionOf("/memoria#la-reforma")).toEqual({
      action: "place",
      key: "story:la-reforma",
    });
    expect(assistantActionOf("/avisos#corte-de-agua")).toEqual({
      action: "place",
      key: "notice:corte-de-agua",
    });
    expect(assistantActionOf("/destinos/museo/tour")).toEqual({
      action: "tour",
      key: "destination_tour:museo",
    });
    expect(assistantActionOf("/agenda/feria/tour?escena=x")).toEqual({
      action: "tour",
      key: "event_tour:feria",
    });
    expect(assistantActionOf("/recorrido")).toEqual({ action: "tour", key: null });
    expect(assistantActionOf("/mapa?ruta=destination:museo")).toEqual({ action: "map", key: null });
    expect(assistantActionOf("/destinos")).toEqual({ action: "section", key: null });
    expect(assistantActionOf("/servicios")).toEqual({ action: "section", key: null });
    expect(assistantActionOf("/")).toEqual({ action: "section", key: null });
  });

  it("is never a path of another site", () => {
    expect(assistantActionOf("https://otra.example/destinos/museo")).toBeNull();
    expect(assistantActionOf("//otra.example/destinos/museo")).toBeNull();
    expect(assistantActionOf("destinos/museo")).toBeNull();
    expect(assistantActionOf(`/${"a".repeat(400)}`)).toBeNull();
  });

  it("reads what the browser reports", () => {
    expect(parseAssistantAction({ ref: REF, path: "/destinos/museo" })).toEqual({
      requestId: REF,
      action: "place",
      key: "destination:museo",
    });
    expect(parseAssistantAction({ ref: REF, action: "person" })).toEqual({
      requestId: REF,
      action: "person",
      key: null,
    });
    expect(parseAssistantAction({ ref: "no", path: "/mapa" })).toBeNull();
    expect(parseAssistantAction({ ref: REF })).toBeNull();
    expect(parseAssistantAction({ ref: REF, path: "https://otra.example/" })).toBeNull();
    expect(parseAssistantAction(null)).toBeNull();
  });
});
