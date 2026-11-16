import { validatePresentation } from "@rikuy/core";
import { describe, expect, it } from "vitest";

import { fieldErrors, presentationInputFromForm, valuesFromPresentation } from "./branding-fields";

function form(entries: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

const filled = {
  siteName: "  Municipio Demo Norte ",
  shortName: "Demo Norte",
  tagline: "",
  mode: "light",
  brand: "#1F6F4A",
  accent: "#a06f12",
  email: "turismo@demo-norte.example.test",
  phone: "",
  address: "",
  description: "Portal de demostración",
  "social.instagram": "https://instagram.example.test/demo",
  "social.facebook": "",
};

describe("branding form mapping", () => {
  it("builds a valid presentation, omitting empty optional fields", () => {
    const input = presentationInputFromForm(form(filled));
    expect(input.contact).toEqual({ email: "turismo@demo-norte.example.test" });
    expect(input.social).toEqual([
      { network: "instagram", url: "https://instagram.example.test/demo" },
    ]);
    expect(input.identity.siteName).toBe("Municipio Demo Norte");
    const result = validatePresentation(input);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(valuesFromPresentation(result.value).social.instagram).toContain("instagram");
  });

  it("carries the theme's style (ADR-061)", () => {
    const immersive = presentationInputFromForm(
      form({ ...filled, style: "immersive", mode: "dark", brand: "#f0a868", accent: "#7fb7d9" }),
    );
    expect(immersive.theme).toMatchObject({ style: "immersive", mode: "dark" });
    const result = validatePresentation(immersive);
    expect(result.ok).toBe(true);
    if (result.ok) expect(valuesFromPresentation(result.value).style).toBe("immersive");

    // A page opened before the themes sends no style: editorial, as before.
    const older = presentationInputFromForm(form(filled));
    expect(older.theme).not.toHaveProperty("style");
    const kept = validatePresentation(older);
    expect(kept.ok && valuesFromPresentation(kept.value).style).toBe("editorial");

    // Immersive on a light background, or an unknown style, is pointed at its field.
    const light = validatePresentation(
      presentationInputFromForm(form({ ...filled, style: "immersive" })),
    );
    expect(light.ok).toBe(false);
    if (!light.ok) expect(fieldErrors(light.issues, []).mode).toContain("Inmersivo");
    const unknown = validatePresentation(
      presentationInputFromForm(form({ ...filled, style: "neon" })),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok)
      expect(fieldErrors(unknown.issues, []).style).toBe("Elige uno de los dos temas.");
  });

  it("carries the logo reference only when both hidden fields are present", () => {
    const asset = "5eed4000-0000-4000-8000-000000000001";
    const withLogo = presentationInputFromForm(
      form({ ...filled, "logo.assetId": asset, "logo.version": "2" }),
    );
    expect(withLogo.logo).toEqual({ assetId: asset, version: 2 });
    const result = validatePresentation(withLogo);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(valuesFromPresentation(result.value)).toMatchObject({
        logoAssetId: asset,
        logoVersion: "2",
      });
    }
    expect(presentationInputFromForm(form(filled))).not.toHaveProperty("logo");

    const forged = presentationInputFromForm(
      form({ ...filled, "logo.assetId": "https://evil.example.test/x.svg", "logo.version": "1e3" }),
    );
    const refused = validatePresentation(forged);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(Object.keys(fieldErrors(refused.issues, []))).toEqual(["logo"]);
  });

  it("carries the crest like the logo, and points at it when it is refused (ADR-068)", () => {
    const asset = "5eed4000-0000-4000-8000-000000000002";
    const withCrest = presentationInputFromForm(
      form({ ...filled, "crest.assetId": asset, "crest.version": "1" }),
    );
    expect(withCrest.crest).toEqual({ assetId: asset, version: 1 });
    const result = validatePresentation(withCrest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(valuesFromPresentation(result.value)).toMatchObject({
        crestAssetId: asset,
        crestVersion: "1",
      });
    }
    expect(presentationInputFromForm(form(filled))).not.toHaveProperty("crest");
    const refused = validatePresentation(
      presentationInputFromForm(
        form({ ...filled, "crest.assetId": "../escudo", "crest.version": "x" }),
      ),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(fieldErrors(refused.issues, []).crest).toContain("escudo");
  });

  it("ignores fields that are not part of the contract", () => {
    const input = presentationInputFromForm(
      form({ ...filled, css: "body{}", "social.myspace": "https://x" }),
    );
    expect(JSON.stringify(input)).not.toContain("body{}");
    expect(input.social.map((s) => s.network)).toEqual(["instagram"]);
  });

  it("maps issues back to the field the person has to fix", () => {
    const input = presentationInputFromForm(
      form({ ...filled, brand: "#ffd400", "social.x": "http://x.example.test/demo" }),
    );
    const result = validatePresentation(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const errors = fieldErrors(result.issues, input.social);
    expect(Object.keys(errors).sort()).toEqual(["social.x"]);

    const contrast = presentationInputFromForm(form({ ...filled, brand: "#ffd400" }));
    const contrastResult = validatePresentation(contrast);
    if (contrastResult.ok) throw new Error("expected a contrast issue");
    expect(fieldErrors(contrastResult.issues, contrast.social).brand).toMatch(/4\.5:1/);
  });

  it("keeps the «Estás cerca de…» radius optional and explains a wrong one", () => {
    expect("visitors" in presentationInputFromForm(form(filled))).toBe(false);
    const ok = validatePresentation(
      presentationInputFromForm(form({ ...filled, nearbyRadius: "300" })),
    );
    expect(ok.ok && ok.value.visitors).toEqual({ nearbyRadius: 300 });
    if (ok.ok) expect(valuesFromPresentation(ok.value).nearbyRadius).toBe("300");
    for (const wrong of ["20", "5000", "1.5", "cien"]) {
      const result = validatePresentation(
        presentationInputFromForm(form({ ...filled, nearbyRadius: wrong })),
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(fieldErrors(result.issues, []).nearbyRadius).toMatch(/entre 50 y 1000/u);
    }
  });

  it("keeps the assistant optional, with a fixed tone, and explains a missing name", () => {
    expect("assistant" in presentationInputFromForm(form(filled))).toBe(false);
    const input = presentationInputFromForm(
      form({ ...filled, assistantName: " Guía ", assistantGreeting: "", assistantTone: "formal" }),
    );
    expect(input.assistant).toEqual({ name: "Guía", greeting: "", tone: "formal" });
    const result = validatePresentation(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(valuesFromPresentation(result.value)).toMatchObject({
        assistantName: "Guía",
        assistantTone: "formal",
      });
    }
    // A tone outside the options becomes the default; it never reaches the contract.
    expect(
      presentationInputFromForm(form({ ...filled, assistantName: "Guía", assistantTone: "pirata" }))
        .assistant?.tone,
    ).toBe("warm");
    const orphan = validatePresentation(
      presentationInputFromForm(form({ ...filled, assistantGreeting: "Hola" })),
    );
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) {
      expect(fieldErrors(orphan.issues, []).assistantName).toMatch(/nombre del asistente/u);
    }
  });

  it("builds the home from its fields, in their order (ADR-062)", () => {
    const data = form({ ...filled, "home.hero.variant": "photo", "home.hero.destination": "" });
    for (const key of ["events", "destinations", "figures", "tours", "passport", "assistant"]) {
      data.append("home.order", key);
    }
    data.set("home.show.events", "on");
    data.set("home.variant.events", "cards");
    data.set("home.show.destinations", "on");
    data.set("home.variant.destinations", "featured");
    data.set("home.variant.figures", "band");
    data.set("home.figure.1.value", "1953");
    data.set("home.figure.1.label", "Firma del decreto");
    data.set("home.figure.2.value", "");
    data.set("home.figure.2.label", "");
    const input = presentationInputFromForm(data);
    expect(input.home).toEqual({
      hero: { variant: "photo", destinationId: null },
      figures: [{ value: "1953", label: "Firma del decreto" }],
      sections: [
        { key: "events", variant: "cards" },
        { key: "destinations", variant: "featured" },
      ],
    });
    const result = validatePresentation(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const values = valuesFromPresentation(result.value).home;
      // Hidden sections keep a place after the shown ones, in their default variant.
      expect(values.sections.map((section) => [section.key, section.shown])).toEqual([
        ["events", true],
        ["destinations", true],
        ["figures", false],
        ["tours", false],
        ["passport", false],
        ["assistant", false],
      ]);
      expect(values.figures[0]).toEqual({ value: "1953", label: "Firma del decreto" });
    }
  });

  it("a form without the home fields leaves the brand's home out (platform default)", () => {
    expect(presentationInputFromForm(form(filled))).not.toHaveProperty("home");
  });

  it("explains a figure with only half of it, and an unknown variant", () => {
    const data = form({ ...filled, "home.hero.variant": "text", "home.figure.2.value": "1953" });
    data.append("home.order", "events");
    data.set("home.show.events", "on");
    data.set("home.variant.events", "featured");
    const result = validatePresentation(presentationInputFromForm(data));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = fieldErrors(result.issues, []);
      expect(errors.homeFigure1).toMatch(/cifra/u);
      expect(errors.homeSections).toMatch(/variante/u);
    }
  });
});
