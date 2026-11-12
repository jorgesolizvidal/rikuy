import type { Measure } from "@rikuy/core";

const NUMBER = new Intl.NumberFormat("es-BO");
const PERCENT = new Intl.NumberFormat("es-BO", { maximumFractionDigits: 0 });

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

/** «▲ 12 %», «▼ 50 %», «= igual», «nuevo»; null when there is nothing to compare with. */
export function changeLabel(
  measure: Measure,
): { readonly short: string; readonly long: string } | null {
  if (measure.previous === null) return null;
  if (measure.previous === 0) {
    return measure.value === 0
      ? { short: "= igual", long: "igual que en el período anterior (0)" }
      : { short: "nuevo", long: "en el período anterior no hubo ninguno" };
  }
  const change = measure.change ?? 0;
  const percent = PERCENT.format(Math.abs(change) * 100);
  const before = formatCount(measure.previous);
  if (Math.abs(change) < 0.005) {
    return { short: "= igual", long: `igual que en el período anterior (${before})` };
  }
  return change > 0
    ? { short: `▲ ${percent} %`, long: `${percent} % más que en el período anterior (${before})` }
    : {
        short: `▼ ${percent} %`,
        long: `${percent} % menos que en el período anterior (${before})`,
      };
}

let regions: Intl.DisplayNames | null = null;

/** «Bolivia», or «Sin identificar» when the CDN could not tell. */
export function countryName(code: string | null): string {
  if (code === null) return "Sin identificar";
  try {
    regions ??= new Intl.DisplayNames(["es"], { type: "region" });
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}
