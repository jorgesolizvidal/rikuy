import { contrastRatio, mostReadable } from "./color";

/**
 * Tenant themes. A tenant chooses a style (ADR-061), a mode and two colors; every other color
 * of the portal is derived here, so a brand can never produce an unreadable page. The style
 * brings the platform's base palette, fonts and components: the municipality never writes
 * CSS nor picks a font.
 */

export type ThemeMode = "light" | "dark";

export const THEME_STYLES = ["editorial", "immersive"] as const;
export type ThemeStyle = (typeof THEME_STYLES)[number];

/** What each style is, for the panel (Spanish UI), and the backgrounds it supports. */
export const THEME_DEFINITIONS: Readonly<
  Record<
    ThemeStyle,
    { readonly name: string; readonly description: string; readonly modes: readonly ThemeMode[] }
  >
> = {
  editorial: {
    name: "Editorial",
    description:
      "Como una revista de viajes: fondo marfil, letra amplia y tarjetas blancas con la foto arriba. Admite fondo claro u oscuro.",
    modes: ["light", "dark"],
  },
  immersive: {
    name: "Inmersivo",
    description:
      "Fondo oscuro, títulos grandes y las fotos a sangre, con el texto encima: pensado para los recorridos 360° y la noche.",
    modes: ["dark"],
  },
};

export function isThemeStyle(value: unknown): value is ThemeStyle {
  return typeof value === "string" && (THEME_STYLES as readonly string[]).includes(value);
}

/** A stored theme without a style is «editorial» (presentations from before ADR-061). */
export function themeStyleOf(choice: { readonly style?: ThemeStyle | undefined }): ThemeStyle {
  return choice.style ?? "editorial";
}

export interface ThemeChoice {
  /** Absent: «editorial». */
  readonly style?: ThemeStyle | undefined;
  readonly mode: ThemeMode;
  /** Main brand color: buttons, links and highlighted text. */
  readonly brand: string;
  /** Secondary color for decorative and non-text UI (borders, markers, focus rings). */
  readonly accent: string;
}

export interface ThemePalette extends ThemeChoice {
  readonly style: ThemeStyle;
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  /** Text color used on top of the brand color (buttons). */
  readonly onBrand: string;
}

type Base = Pick<ThemePalette, "background" | "surface" | "text" | "muted">;

/**
 * The platform's neutrals for each style and background. Editorial on light is the ivory of
 * the Stitch direction («Tierra Viva Editorial»); immersive is a green-tinted night.
 */
const BASE: Readonly<Record<ThemeStyle, Partial<Record<ThemeMode, Base>>>> = {
  editorial: {
    light: { background: "#fbf9f4", surface: "#ffffff", text: "#1b1c19", muted: "#4a524b" },
    dark: { background: "#101312", surface: "#191d1b", text: "#eef1ee", muted: "#a3aaa6" },
  },
  immersive: {
    dark: { background: "#0c110e", surface: "#161d19", text: "#f3f1ea", muted: "#aeb7b0" },
  },
};

function baseOf(style: ThemeStyle, mode: ThemeMode): Base {
  // A combination the contract rejects (immersive on light) falls back to the style's own
  // background, never to an unreadable mix.
  return BASE[style][mode] ?? BASE[style].dark ?? (BASE.editorial[mode] as Base);
}

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

/** Whether a style admits a background (immersive is only dark). */
export function styleAllowsMode(style: ThemeStyle, mode: ThemeMode): boolean {
  return THEME_DEFINITIONS[style].modes.includes(mode);
}

export function deriveTheme(choice: ThemeChoice): ThemePalette {
  const style = themeStyleOf(choice);
  const mode = styleAllowsMode(style, choice.mode) ? choice.mode : "dark";
  return {
    ...choice,
    style,
    mode,
    ...baseOf(style, mode),
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
