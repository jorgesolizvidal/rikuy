import {
  canManageMembers,
  hasModule,
  type ModuleKey,
  type OrganizationMembership,
} from "@rikuy/core";

import type { PanelNavGroup } from "./panel-nav-current";

/**
 * The municipality's menu in the panel (C3 · Paso 7, ADR-066): its sections grouped, only the
 * modules it has (ADR-060) and what the person's role can open. The pages check it again; the
 * menu only leaves out what would answer 404.
 */

export type { PanelNavGroup, PanelNavItem } from "./panel-nav-current";

type Member = Pick<OrganizationMembership, "slug" | "role" | "modules" | "demo">;

interface Entry {
  readonly path: string;
  readonly label: string;
  readonly module?: ModuleKey;
  readonly when?: (member: Member) => boolean;
}

const GROUPS: readonly { readonly title: string | null; readonly entries: readonly Entry[] }[] = [
  { title: null, entries: [{ path: "", label: "Inicio" }] },
  {
    title: "Contenido",
    entries: [
      { path: "destinos", label: "Destinos" },
      { path: "agenda", label: "Agenda", module: "agenda" },
      { path: "avisos", label: "Avisos" },
      { path: "categorias", label: "Categorías" },
      { path: "tours", label: "Tours 360°", module: "tours" },
      { path: "panoramas", label: "Panoramas 360°", module: "tours" },
      { path: "modelos", label: "Modelos 3D", module: "models" },
      { path: "copilot", label: "Copilot", module: "copilot" },
    ],
  },
  {
    title: "Para visitantes",
    entries: [
      { path: "pasaporte", label: "Pasaporte turístico", module: "passport" },
      { path: "conocimiento", label: "Conocimiento del asistente", module: "assistant" },
    ],
  },
  {
    title: "Resultados",
    entries: [
      { path: "estadisticas", label: "Estadísticas" },
      { path: "preguntas", label: "Lo que preguntan los visitantes", module: "assistant" },
      { path: "informe", label: "Informe mensual" },
    ],
  },
  {
    title: "Ajustes",
    entries: [
      { path: "configuracion", label: "Marca del portal" },
      {
        path: "miembros",
        label: "Miembros",
        when: (member) => canManageMembers(member.role),
      },
      { path: "uso", label: "Uso del plan" },
      {
        path: "muestra",
        label: "Contenido de muestra",
        when: (member) => member.demo === true && ["owner", "admin"].includes(member.role),
      },
    ],
  },
];

export function panelNav(member: Member): readonly PanelNavGroup[] {
  const base = `/o/${member.slug}`;
  return GROUPS.map((group) => ({
    title: group.title,
    items: group.entries
      .filter((entry) => !entry.module || hasModule(member.modules, entry.module))
      .filter((entry) => !entry.when || entry.when(member))
      .map((entry) => ({ href: entry.path ? `${base}/${entry.path}` : base, label: entry.label })),
  })).filter((group) => group.items.length > 0);
}

export { currentNavHref } from "./panel-nav-current";
