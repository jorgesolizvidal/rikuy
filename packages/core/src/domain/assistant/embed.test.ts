import { describe, expect, it } from "vitest";

import {
  frameAncestors,
  isEmbedOrigin,
  parseEmbedOrigin,
  parseEmbedPlace,
  parseWebLink,
  webLinkOrigin,
} from "./embed";

describe("the websites where the assistant may be embedded (ADR-071)", () => {
  it("takes a website as the operator types it, as an origin", () => {
    expect(parseEmbedOrigin("www.ucurena.gob.bo")).toBe("https://www.ucurena.gob.bo");
    expect(parseEmbedOrigin("  https://WWW.Ucurena.gob.bo/ ")).toBe("https://www.ucurena.gob.bo");
    expect(parseEmbedOrigin("https://turismo.cliza.bo:8443")).toBe("https://turismo.cliza.bo:8443");
    expect(parseEmbedOrigin("http://localhost:4599")).toBe("http://localhost:4599");
    expect(parseEmbedOrigin("http://127.0.0.1:4599/")).toBe("http://127.0.0.1:4599");
  });

  it("refuses part of a website, plain http on the internet and anything that is not one", () => {
    for (const value of [
      "https://www.ucurena.gob.bo/turismo",
      "https://www.ucurena.gob.bo/?a=1",
      "https://www.ucurena.gob.bo/#x",
      "http://www.ucurena.gob.bo",
      "https://user:pass@ucurena.gob.bo",
      "https://localhost",
      "ftp://ucurena.gob.bo",
      "*",
      "https://*.gob.bo",
      "ucurena",
      "",
      "www.ucurena .gob.bo",
      42,
      null,
    ]) {
      expect(parseEmbedOrigin(value), String(value)).toBeNull();
    }
  });

  it("checks origins the way the database does", () => {
    expect(isEmbedOrigin("https://www.ucurena.gob.bo")).toBe(true);
    expect(isEmbedOrigin("https://xn--ucurea-wwa.bo")).toBe(true);
    expect(isEmbedOrigin("https://WWW.ucurena.gob.bo")).toBe(false);
    expect(isEmbedOrigin("https://ucurena")).toBe(false);
    expect(isEmbedOrigin("https://ucurena.gob.bo/")).toBe(false);
  });

  it("finds the origin of a link, never one hidden behind a user name", () => {
    expect(webLinkOrigin("https://www.ucurena.gob.bo/turismo/museo?x=1#mapa")).toBe(
      "https://www.ucurena.gob.bo",
    );
    expect(webLinkOrigin("https://www.ucurena.gob.bo")).toBe("https://www.ucurena.gob.bo");
    expect(webLinkOrigin("https://www.ucurena.gob.bo@evil.com/")).toBeNull();
    expect(webLinkOrigin("javascript:alert(1)")).toBeNull();
    expect(webLinkOrigin("https://www.ucurena.gob.bo/a b")).toBeNull();
    expect(webLinkOrigin(`https://www.ucurena.gob.bo/${"a".repeat(500)}`)).toBeNull();
  });

  it("accepts a page of the municipality's own website, and only there", () => {
    const origins = ["https://www.ucurena.gob.bo"];
    expect(parseWebLink(" https://www.ucurena.gob.bo/turismo/museo ", origins)).toEqual({
      status: "ok",
      url: "https://www.ucurena.gob.bo/turismo/museo",
    });
    expect(parseWebLink("https://WWW.UCURENA.gob.bo/Museo", origins)).toEqual({
      status: "ok",
      url: "https://www.ucurena.gob.bo/Museo",
    });
    expect(parseWebLink("", origins)).toEqual({ status: "ok", url: null });
    expect(parseWebLink("https://otro.bo/museo", origins)).toEqual({ status: "origin" });
    expect(parseWebLink("https://www.ucurena.gob.bo.evil.com/", origins)).toEqual({
      status: "origin",
    });
    expect(parseWebLink("www.ucurena.gob.bo/museo", origins)).toEqual({ status: "invalid" });
    expect(parseWebLink("https://a@www.ucurena.gob.bo/", origins)).toEqual({ status: "invalid" });
    expect(parseWebLink("javascript:alert(1)", origins)).toEqual({ status: "invalid" });
    expect(parseWebLink(3, origins)).toEqual({ status: "invalid" });
  });

  it("reads the place a page of the website is about", () => {
    expect(parseEmbedPlace("destinos/museo-de-ucurena")).toEqual({
      kind: "destination",
      slug: "museo-de-ucurena",
    });
    expect(parseEmbedPlace("/agenda/carnaval")).toEqual({ kind: "event", slug: "carnaval" });
    expect(parseEmbedPlace("servicios/cajero")).toBeNull();
    expect(parseEmbedPlace("destinos/../admin")).toBeNull();
    expect(parseEmbedPlace("destinos/Museo")).toBeNull();
    expect(parseEmbedPlace(undefined)).toBeNull();
  });

  it("lets only the municipality's websites show the frame", () => {
    expect(frameAncestors(["https://www.ucurena.gob.bo", "http://localhost:4599"])).toBe(
      "'self' https://www.ucurena.gob.bo http://localhost:4599",
    );
    expect(frameAncestors(["https://x.bo; script-src *"])).toBe("'self'");
    expect(frameAncestors([])).toBe("'self'");
  });
});
