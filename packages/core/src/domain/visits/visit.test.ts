import { describe, expect, it } from "vitest";

import { qrCodeUrl } from "../../application/content/portal";
import {
  isAutomatedAgent,
  parseVisitBeacon,
  visitEventAllowed,
  visitOrigin,
  visitorKey,
  visitRecordFrom,
} from "./visit";

const SCENE = "5eed4000-0000-4000-8000-000000000001";
const CHROME =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";

describe("visit beacons", () => {
  it("reads pages and places from the path", () => {
    expect(parseVisitBeacon({ path: "/", event: "view" })).toEqual({
      target: "home",
      slug: null,
      sceneId: null,
      event: "view",
    });
    expect(parseVisitBeacon({ path: "/destinos/museo-de-ucurena", event: "directions" })).toEqual({
      target: "destination",
      slug: "museo-de-ucurena",
      sceneId: null,
      event: "directions",
    });
    expect(parseVisitBeacon({ path: "/agenda/feria/tour", event: "scene", scene: SCENE })).toEqual({
      target: "event_tour",
      slug: "feria",
      sceneId: SCENE,
      event: "scene",
    });
    expect(parseVisitBeacon({ path: "/recorrido", event: "qr" })?.target).toBe("general_tour");
  });

  it("refuses what a page cannot report, unknown pages and malformed bodies", () => {
    for (const body of [
      { path: "/", event: "directions" },
      { path: "/destinos/museo", event: "calendar" },
      { path: "/mapa", event: "qr" },
      { path: "/destinos/museo/tour", event: "scene" },
      { path: "/destinos/museo/tour", event: "scene", scene: "no-es-un-id" },
      { path: "/destinos/museo", event: "view", scene: SCENE },
      { path: "/privacidad", event: "view" },
      { path: "/destinos/Museo", event: "view" },
      { path: "destinos", event: "view" },
      { path: `/${"a".repeat(250)}`, event: "view" },
      { path: "/", event: "click" },
      { path: "/" },
      null,
      [],
      "texto",
    ]) {
      expect(parseVisitBeacon(body)).toBeNull();
    }
  });

  it("has the same event rules as the database", () => {
    expect(visitEventAllowed("event", "calendar")).toBe(true);
    expect(visitEventAllowed("destination", "calendar")).toBe(false);
    expect(visitEventAllowed("general_tour", "qr")).toBe(true);
    expect(visitEventAllowed("home", "qr")).toBe(false);
    expect(visitEventAllowed("map", "view")).toBe(true);
  });
});

describe("visit origin and visitor", () => {
  it("keeps a valid country and its decoded city", () => {
    expect(visitOrigin("BO", "Cochabamba")).toEqual({ country: "BO", city: "Cochabamba" });
    expect(visitOrigin("bo", "San%20Jos%C3%A9")).toEqual({ country: "BO", city: "San José" });
    expect(visitOrigin("AR", "%E0%A4%A")).toEqual({ country: "AR", city: null });
    expect(visitOrigin("BO", "a%0Ab")).toEqual({ country: "BO", city: "ab" });
  });

  it("drops a city without a valid country", () => {
    expect(visitOrigin(null, "Cochabamba")).toEqual({ country: null, city: null });
    expect(visitOrigin("XX", "Somewhere")).toEqual({ country: null, city: null });
    expect(visitOrigin("Bolivia", null)).toEqual({ country: null, city: null });
  });

  it("builds the key the database hashes, or none without an address", () => {
    expect(visitorKey("1.2.3.4", "UA")).toBe("1.2.3.4|UA");
    expect(visitorKey(null, "UA")).toBeNull();
    expect(visitorKey(" ", "UA")).toBeNull();
  });

  it("never counts search engines, previews, Lighthouse or scripts", () => {
    for (const agent of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36 Chrome-Lighthouse",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0 Safari/537.36",
      "WhatsApp/2.24.1 A",
      "facebookexternalhit/1.1",
      "curl/8.5.0",
      null,
      "",
    ]) {
      expect(isAutomatedAgent(agent)).toBe(true);
    }
    expect(isAutomatedAgent(CHROME)).toBe(false);
  });
});

describe("visit records", () => {
  const input = {
    tenantId: "t",
    body: { path: "/destinos/museo", event: "view" },
    userAgent: CHROME,
    address: "1.2.3.4",
    country: "BO",
    city: "Cliza",
  };

  it("joins the hit, the origin and the visitor key", () => {
    expect(visitRecordFrom(input)).toEqual({
      tenantId: "t",
      target: "destination",
      slug: "museo",
      sceneId: null,
      event: "view",
      country: "BO",
      city: "Cliza",
      visitor: `1.2.3.4|${CHROME}`,
    });
  });

  it("is nothing for a robot or a bad beacon", () => {
    expect(visitRecordFrom({ ...input, userAgent: "Googlebot" })).toBeNull();
    expect(visitRecordFrom({ ...input, body: { path: "/x", event: "view" } })).toBeNull();
  });
});

describe("QR codes", () => {
  it("mark the address they open, keeping its query", () => {
    expect(qrCodeUrl("https://demo.example/destinos/museo")).toBe(
      "https://demo.example/destinos/museo?qr=1",
    );
    expect(qrCodeUrl("https://demo.example/recorrido?escena=abc")).toBe(
      "https://demo.example/recorrido?escena=abc&qr=1",
    );
  });
});
