import { MODULE_KEYS } from "@rikuy/core";
import { describe, expect, it } from "vitest";

import { currentNavHref, panelNav } from "./panel-nav";

const labels = (groups: ReturnType<typeof panelNav>) =>
  groups.map((group) => [group.title, group.items.map((item) => item.label)]);

describe("the municipality's menu in the panel (ADR-066)", () => {
  it("groups every section for an owner with all the modules", () => {
    const groups = panelNav({ slug: "demo-norte", role: "owner", modules: [...MODULE_KEYS] });
    expect(labels(groups)).toEqual([
      [null, ["Inicio"]],
      [
        "Contenido",
        [
          "Destinos",
          "Agenda",
          "Categorías",
          "Tours 360°",
          "Panoramas 360°",
          "Modelos 3D",
          "Copilot",
        ],
      ],
      ["Para visitantes", ["Pasaporte turístico", "Conocimiento del asistente"]],
      ["Resultados", ["Estadísticas", "Lo que preguntan los visitantes", "Informe mensual"]],
      ["Ajustes", ["Marca del portal", "Miembros", "Uso del plan"]],
    ]);
    expect(groups[0]?.items[0]?.href).toBe("/o/demo-norte");
    expect(groups[1]?.items[0]?.href).toBe("/o/demo-norte/destinos");
  });

  it("leaves out the modules the municipality does not have", () => {
    const groups = panelNav({ slug: "x", role: "editor", modules: [] });
    expect(labels(groups)).toEqual([
      [null, ["Inicio"]],
      ["Contenido", ["Destinos", "Categorías"]],
      ["Resultados", ["Estadísticas", "Informe mensual"]],
      ["Ajustes", ["Marca del portal", "Uso del plan"]],
    ]);
  });

  it("a menu read before the modules existed has them all", () => {
    const groups = panelNav({ slug: "x", role: "analyst" });
    expect(groups.flatMap((group) => group.items).map((item) => item.label)).toContain("Copilot");
  });

  it("members for owners and admins; the sample content only in a demo, for them", () => {
    const items = (role: "owner" | "admin" | "editor" | "analyst", demo: boolean) =>
      panelNav({ slug: "x", role, modules: [], demo })
        .flatMap((group) => group.items)
        .map((item) => item.label);
    expect(items("admin", false)).toContain("Miembros");
    expect(items("editor", true)).not.toContain("Miembros");
    expect(items("analyst", true)).not.toContain("Contenido de muestra");
    expect(items("owner", false)).not.toContain("Contenido de muestra");
    expect(items("admin", true)).toContain("Contenido de muestra");
  });

  it("marks the section a page belongs to", () => {
    const groups = panelNav({ slug: "demo-norte", role: "owner", modules: [...MODULE_KEYS] });
    expect(currentNavHref(groups, "/o/demo-norte")).toBe("/o/demo-norte");
    expect(currentNavHref(groups, "/o/demo-norte/")).toBe("/o/demo-norte");
    expect(currentNavHref(groups, "/o/demo-norte/destinos/abc")).toBe("/o/demo-norte/destinos");
    expect(currentNavHref(groups, "/o/demo-norte/copilot/propuestas/1")).toBe(
      "/o/demo-norte/copilot",
    );
    // «Inicio» is only the home itself; an unknown page marks nothing.
    expect(currentNavHref(groups, "/o/demo-norte/otra")).toBeNull();
    expect(currentNavHref(groups, "/o/demo-norte-2")).toBeNull();
  });
});
