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
});
