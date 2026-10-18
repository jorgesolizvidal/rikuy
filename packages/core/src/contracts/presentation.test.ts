import { describe, expect, it } from "vitest";

import {
  defaultPresentation,
  deriveShortName,
  monogram,
  parseStoredPresentation,
  validatePresentation,
} from "./presentation";
import { samplePresentation } from "../testing/presentation-fixture";

function issues(input: unknown) {
  const result = validatePresentation(input);
  return result.ok ? [] : result.issues;
}

describe("presentation contract", () => {
  it("accepts a complete presentation and normalizes colors to lowercase", () => {
    const result = validatePresentation(samplePresentation());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.theme.brand).toBe("#1f6f4a");
  });

  it("rejects unknown keys anywhere (no smuggled fields)", () => {
    const input = { ...samplePresentation(), css: "body{display:none}" };
    expect(issues(input)).toEqual([{ path: "", code: "invalid" }]);
    const nested = samplePresentation();
    expect(
      issues({ ...nested, theme: { ...nested.theme, fontFamily: "Comic Sans" } })[0]?.path,
    ).toBe("theme");
  });

  it.each([
    ["theme.brand", { theme: { mode: "light", brand: "red", accent: "#a06f12" } }],
    ["theme.brand", { theme: { mode: "light", brand: "#fff;}body{", accent: "#a06f12" } }],
    [
      "identity.shortName",
      { identity: { siteName: "Ok", shortName: "Nombre demasiado largo", tagline: "" } },
    ],
    ["identity.siteName", { identity: { siteName: "Linea\nnueva", shortName: "Ok", tagline: "" } }],
    ["identity.siteName", { identity: { siteName: "   ", shortName: "Ok", tagline: "" } }],
    ["contact.email", { contact: { email: "not-an-email" } }],
    ["contact.phone", { contact: { phone: "llámame" } }],
    ["social.0.url", { social: [{ network: "x", url: "http://x.com/demo" }] }],
    ["social.0.url", { social: [{ network: "x", url: "javascript:alert(1)" }] }],
    ["social.0.url", { social: [{ network: "x", url: "https://user:pass@x.com" }] }],
    ["social.0.network", { social: [{ network: "myspace", url: "https://myspace.com/a" }] }],
    [
      "social",
      {
        social: [
          { network: "x", url: "https://x.com/a" },
          { network: "x", url: "https://x.com/b" },
        ],
      },
    ],
    ["seo.description", { seo: { description: "a".repeat(161) } }],
  ])("rejects an invalid %s", (path, patch) => {
    expect(issues({ ...samplePresentation(), ...patch }).map((i) => i.path)).toContain(path);
  });

  it("rejects themes that fail WCAG AA", () => {
    expect(
      issues({
        ...samplePresentation(),
        theme: { mode: "light", brand: "#f5d90a", accent: "#a06f12" },
      }),
    ).toEqual([{ path: "theme.brand", code: "contrast.brandOnBackground" }]);
    expect(
      issues({
        ...samplePresentation(),
        theme: { mode: "dark", brand: "#f0a868", accent: "#222222" },
      }),
    ).toEqual([{ path: "theme.accent", code: "contrast.accentOnBackground" }]);
  });

  it("parses stored values without re-checking contrast and returns null for garbage", () => {
    expect(parseStoredPresentation(samplePresentation())?.identity.shortName).toBe("Demo Norte");
    expect(parseStoredPresentation({})).toBeNull();
    expect(parseStoredPresentation("<script>")).toBeNull();
  });
});

describe("defaults", () => {
  it.each([
    ["Municipio Demo Norte", "Demo Norte"],
    ["Sur", "Sur"],
    ["Supercalifragilístico", "Supercalifra"],
    ["Villa de Peña Alta del Valle", "del Valle"],
  ])("derives a short name from %s", (name, short) => {
    expect(deriveShortName(name)).toBe(short);
  });

  it("produces a valid, accessible default presentation", () => {
    const result = validatePresentation(defaultPresentation({ displayName: "Municipio Demo Sur" }));
    expect(result.ok).toBe(true);
  });

  it.each([
    ["Demo Norte", "DN"],
    ["sur", "S"],
    ["Ñuñoa centro histórico", "ÑC"],
  ])("builds the monogram of %s", (name, expected) => {
    expect(monogram(name)).toBe(expected);
  });
});
