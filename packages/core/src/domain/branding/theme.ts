import { contrastRatio, mostReadable } from "./color";

/**
 * Tenant themes. A tenant chooses only a mode and two colors; every other color of the
 * portal is derived here, so a brand can never produce an unreadable page.
 */

export type ThemeMode = "light" | "dark";

export interface ThemeChoice {
  readonly mode: ThemeMode;
  /** Main brand color: buttons, links and highlighted text. */
  readonly brand: string;
  /** Secondary color for decorative and non-text UI (borders, markers, focus rings). */
  readonly accent: string;
}

export interface ThemePalette extends ThemeChoice {
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  /** Text color used on top of the brand color (buttons). */
  readonly onBrand: string;
}

const BASE: Readonly<
  Record<ThemeMode, Pick<ThemePalette, "background" | "surface" | "text" | "muted">>
> = {
  light: { background: "#f7f8f6", surface: "#ffffff", text: "#1a1d1c", muted: "#555b58" },
  dark: { background: "#101312", surface: "#191d1b", text: "#eef1ee", muted: "#a3aaa6" },
};

const INK = ["#ffffff", "#101312"] as const;

/** WCAG 2.x AA: 4.5:1 for text, 3:1 for non-text UI components (SC 1.4.3 / 1.4.11). */
export const CONTRAST_MINIMUMS = {
  brandOnBackground: 4.5,
  textOnBrand: 4.5,
  accentOnBackground: 3,
} as const;

export type ContrastCheck = keyof typeof CONTRAST_MINIMUMS;

export interface ContrastResult {
  readonly check: ContrastCheck;
  readonly ratio: number;
  readonly minimum: number;
  readonly passes: boolean;
}

export function deriveTheme(choice: ThemeChoice): ThemePalette {
  return {
    ...choice,
    ...BASE[choice.mode],
    onBrand: mostReadable(choice.brand, INK),
  };
}

export function themeContrast(choice: ThemeChoice): ContrastResult[] {
  const palette = deriveTheme(choice);
  const ratios: Record<ContrastCheck, number> = {
    brandOnBackground: contrastRatio(palette.brand, palette.background),
    textOnBrand: contrastRatio(palette.onBrand, palette.brand),
    accentOnBackground: contrastRatio(palette.accent, palette.background),
  };
  return (Object.keys(CONTRAST_MINIMUMS) as ContrastCheck[]).map((check) => ({
    check,
    ratio: ratios[check],
    minimum: CONTRAST_MINIMUMS[check],
    passes: ratios[check] >= CONTRAST_MINIMUMS[check],
  }));
}

/**
 * CSS custom properties for a palette. Values are validated `#rrggbb` colors, so the
 * result is safe to place in a `style` attribute.
 */
export function themeCssVariables(palette: ThemePalette): Record<`--${string}`, string> {
  return {
    "--bg": palette.background,
    "--surface": palette.surface,
    "--fg": palette.text,
    "--muted": palette.muted,
    "--brand": palette.brand,
    "--on-brand": palette.onBrand,
    "--accent": palette.accent,
  };
}
