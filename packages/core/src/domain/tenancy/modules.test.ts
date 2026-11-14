import { describe, expect, it } from "vitest";

import {
  checkModuleSet,
  hasModule,
  MODULE_KEYS,
  MODULE_PACKAGES,
  MODULES,
  passageVisibleWith,
} from "./modules";

describe("modules of a municipality (ADR-060)", () => {
  it("has every key in the catalog once, with its requirement before it", () => {
    expect(MODULES.map((module) => module.key)).toEqual([...MODULE_KEYS]);
    for (const module of MODULES) {
      if (module.requires) {
        expect(MODULE_KEYS.indexOf(module.requires)).toBeLessThan(MODULE_KEYS.indexOf(module.key));
      }
    }
  });

  it("an unknown set means everything; a known one, only what it lists", () => {
    expect(hasModule(undefined, "passport")).toBe(true);
    expect(hasModule(["agenda", "map"], "passport")).toBe(false);
    expect(hasModule(["agenda", "map"], "map")).toBe(true);
    expect(hasModule([], "agenda")).toBe(false);
  });

  it("checks a requested set and puts it in the catalog's order", () => {
    expect(checkModuleSet(["copilot", "agenda"])).toEqual({
      status: "ok",
      modules: ["agenda", "copilot"],
    });
    expect(checkModuleSet([])).toEqual({ status: "ok", modules: [] });
    expect(checkModuleSet(["voice"])).toEqual({
      status: "requires",
      module: "voice",
      needs: "assistant",
    });
    expect(checkModuleSet(["agenda", "agenda"])).toEqual({ status: "invalid" });
    expect(checkModuleSet(["agenda", 3])).toEqual({ status: "invalid" });
    expect(checkModuleSet(["restaurantes"])).toEqual({ status: "invalid" });
  });

  it("both packages are valid sets", () => {
    for (const modules of Object.values(MODULE_PACKAGES)) {
      expect(checkModuleSet([...modules]).status).toBe("ok");
    }
  });
});

describe("what the assistant may read (ADR-060)", () => {
  it("leaves out tours without the tours and events without the agenda", () => {
    const tour = { source: "tour", kind: "destination" } as const;
    const event = { source: "content", kind: "event" } as const;
    const destination = { source: "content", kind: "destination" } as const;
    expect(passageVisibleWith(undefined, tour)).toBe(true);
    expect(passageVisibleWith(["agenda"], tour)).toBe(false);
    expect(passageVisibleWith(["tours"], event)).toBe(false);
    expect(passageVisibleWith(["agenda"], event)).toBe(true);
    expect(passageVisibleWith([], destination)).toBe(true);
  });
});
