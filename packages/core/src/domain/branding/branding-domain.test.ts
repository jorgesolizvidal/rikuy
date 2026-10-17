import { describe, expect, it } from "vitest";

import { contrastRatio, isHexColor, mostReadable, relativeLuminance } from "./color";
import { CONTRAST_MINIMUMS, deriveTheme, themeContrast, themeCssVariables } from "./theme";

describe("WCAG contrast", () => {
  it("matches reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // #777777 on white is the classic "just below AA" grey.
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#ffffff", "#777777")).toBeCloseTo(4.48, 2);
  });

  it("computes luminance and rejects anything that is not #rrggbb", () => {
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
    expect(relativeLuminance("#000000")).toBe(0);
    for (const bad of ["#FFF", "fff", "#ffffff;", "red", "#ff00ff00", "#FFFFFF"]) {
      expect(isHexColor(bad)).toBe(false);
    }
    expect(() => relativeLuminance("red")).toThrow();
  });

  it("picks the most readable ink", () => {
    expect(mostReadable("#ffff00", ["#ffffff", "#101312"])).toBe("#101312");
    expect(mostReadable("#1f3a8a", ["#ffffff", "#101312"])).toBe("#ffffff");
  });
});

describe("themes", () => {
  it("derives the palette from mode + two colors", () => {
    const light = deriveTheme({ mode: "light", brand: "#1f6f4a", accent: "#a06f12" });
    expect(light.background).toBe("#f7f8f6");
    expect(light.onBrand).toBe("#ffffff");
    const dark = deriveTheme({ mode: "dark", brand: "#f0a868", accent: "#7fb7d9" });
    expect(dark.background).toBe("#101312");
    expect(dark.onBrand).toBe("#101312");
  });

  it("reports every AA check", () => {
    const results = themeContrast({ mode: "light", brand: "#f5d90a", accent: "#eeeeee" });
    expect(results.map((r) => r.check)).toEqual(Object.keys(CONTRAST_MINIMUMS));
    expect(results.find((r) => r.check === "brandOnBackground")?.passes).toBe(false);
    expect(results.find((r) => r.check === "accentOnBackground")?.passes).toBe(false);
    // Yellow is fine as a button background: dark ink on it has plenty of contrast.
    expect(results.find((r) => r.check === "textOnBrand")?.passes).toBe(true);
  });

  it("only emits validated colors as CSS variables", () => {
    const vars = themeCssVariables(
      deriveTheme({ mode: "dark", brand: "#f0a868", accent: "#7fb7d9" }),
    );
    for (const value of Object.values(vars)) expect(isHexColor(value)).toBe(true);
    expect(Object.keys(vars)).toContain("--brand");
  });
});
