import { describe, expect, it } from "vitest";

import {
  homeOf,
  validatePresentation,
  type TenantPresentation,
} from "../../contracts/presentation";
import type { ModuleKey } from "../tenancy/modules";
import {
  bottomBar,
  DEFAULT_HOME,
  HOME_SECTIONS,
  homeFigures,
  isHomeVariant,
  visibleHomeSections,
} from "./home";

const BASE: TenantPresentation = {
  identity: { siteName: "Municipio", shortName: "Muni", tagline: "" },
  theme: { style: "editorial", mode: "light", brand: "#14532d", accent: "#b45309" },
  contact: {},
  social: [],
  seo: { description: "" },
};

const all = () => true;
const without =
  (...off: ModuleKey[]) =>
  (module: ModuleKey) =>
    !off.includes(module);

describe("home layout (ADR-062)", () => {
  it("the default has every section once, in the catalog's order and first variant", () => {
    expect(DEFAULT_HOME.hero).toEqual({ variant: "photo", destinationId: null });
    expect(DEFAULT_HOME.sections.map((section) => section.key)).toEqual(
      HOME_SECTIONS.map((section) => section.key),
    );
    for (const section of DEFAULT_HOME.sections) {
      expect(isHomeVariant(section.key, section.variant)).toBe(true);
    }
    expect(homeOf(BASE)).toBe(DEFAULT_HOME);
  });

  it("a brand's own home replaces the default", () => {
    const home = {
      hero: { variant: "text" as const, destinationId: null },
      figures: [],
      sections: [{ key: "events" as const, variant: "cards" }],
    };
    expect(homeOf({ ...BASE, home })).toEqual(home);
  });

  it("sections of a module the municipality does not have are hidden", () => {
    const keys = visibleHomeSections(DEFAULT_HOME, without("agenda", "passport")).map(
      (section) => section.key,
    );
    expect(keys).toEqual(["figures", "destinations", "tours", "assistant"]);
    expect(visibleHomeSections(DEFAULT_HOME, all)).toHaveLength(HOME_SECTIONS.length);
  });

  it("the contract accepts a full home and the database's shapes only", () => {
    const home = {
      hero: { variant: "photo", destinationId: "5eed4100-0000-4000-8000-000000000001" },
      figures: [{ value: "1953", label: "Firma del decreto" }],
      sections: [
        { key: "figures", variant: "band" },
        { key: "destinations", variant: "featured" },
        { key: "events", variant: "list" },
      ],
    };
    expect(validatePresentation({ ...BASE, home }).ok).toBe(true);
    const bad = [
      { ...home, hero: { variant: "video", destinationId: null } },
      { ...home, hero: { variant: "photo", destinationId: "plaza" } },
      { ...home, sections: [{ key: "events", variant: "featured" }] },
      { ...home, sections: [{ key: "map", variant: "banner" }] },
      { ...home, sections: [home.sections[0], home.sections[0]] },
      { ...home, figures: [1, 2, 3].map((n) => ({ value: String(n), label: "x" })) },
      { ...home, figures: [{ value: "1234567890123", label: "x" }] },
      { ...home, figures: [{ value: "1", label: "dos\nlíneas" }] },
      { ...home, figures: [{ value: "1", label: "x", href: "https://x.test" }] },
    ];
    for (const value of bad) {
      expect(validatePresentation({ ...BASE, home: value }).ok).toBe(false);
    }
  });
});

describe("figures band", () => {
  const counts = { destinations: 7, tours: 3, events: 1, circuits: 2 };

  it("the municipality's figures first, then what the portal counts, up to four", () => {
    const own = [{ value: "1953", label: "Firma del Decreto de Reforma Agraria" }];
    expect(homeFigures(own, counts, all)).toEqual([
      own[0],
      { value: "7", label: "Lugares para visitar" },
      { value: "3", label: "Recorridos 360°" },
      { value: "1", label: "Evento próximo" },
    ]);
  });

  it("never a zero, never a module the municipality does not have", () => {
    expect(
      homeFigures([], { destinations: 1, tours: 0, events: 4, circuits: 2 }, without("passport")),
    ).toEqual([
      { value: "1", label: "Lugar para visitar" },
      { value: "4", label: "Eventos próximos" },
    ]);
    expect(homeFigures([], { destinations: 0, tours: 0, events: 0, circuits: 0 }, all)).toEqual([]);
  });
});

describe("bottom bar on the phone", () => {
  it("with everything: four places and «Más» with the rest", () => {
    const bar = bottomBar({ agenda: true, map: true, tours: true, passport: true });
    expect(bar.items.map((item) => item.label)).toEqual([
      "Inicio",
      "Destinos",
      "Agenda",
      "Pasaporte",
    ]);
    expect(bar.more.map((item) => item.label)).toEqual(["Mapa", "Tours 360°"]);
  });

  it("only what the municipality has, in a fixed order, without «Más» when it fits", () => {
    expect(
      bottomBar({ agenda: true, map: true, tours: true, passport: false }).items.map(
        (item) => item.key,
      ),
    ).toEqual(["home", "destinations", "agenda", "map", "tours"]);
    expect(bottomBar({ agenda: false, map: false, tours: false, passport: false })).toEqual({
      items: [
        { key: "home", label: "Inicio" },
        { key: "destinations", label: "Destinos" },
      ],
      more: [],
    });
  });
});
