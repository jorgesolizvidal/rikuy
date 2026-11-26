import { describe, expect, it, vi } from "vitest";

import type { KnowledgePassage } from "../../contracts/knowledge";
import type { OrganizationMembership } from "../../contracts/organization";
import {
  emptyServiceDocument,
  servicePublicationIssues,
  validateServiceDocument,
} from "../../contracts/service";
import { contentUnits } from "../../domain/knowledge/sources";
import { SERVICE_CATEGORY_INFO, telHref, whatsappHref } from "../../domain/services/categories";
import { checkModuleSet, MODULE_PACKAGES, passageVisibleWith } from "../../domain/tenancy/modules";
import { publicCitation } from "../knowledge/search";
import type { ServiceRepository } from "./ports";
import {
  groupServices,
  listServices,
  publishService,
  retireService,
  saveServiceDraft,
  servicesOnMap,
} from "./services";

const member = (role: OrganizationMembership["role"]): OrganizationMembership =>
  ({ tenantId: "t1", role }) as OrganizationMembership;

const doc = (changes: Record<string, unknown> = {}) => ({
  ...emptyServiceDocument("Restaurante La Casona", "food"),
  summary: "Almuerzos y comida típica.",
  phone: "4 4441234",
  whatsapp: "+591 70000000",
  address: "Calle Bolívar 12",
  ...changes,
});

function repository(overrides: Partial<ServiceRepository> = {}): ServiceRepository {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(),
    find: vi.fn(),
    revisionDocument: vi.fn(),
    saveDraft: vi.fn(async () => ({ status: "saved" as const, revisionNo: 1, editCount: 2 })),
    publish: vi.fn(async () => ({ status: "published" as const, revisionNo: 1 })),
    retire: vi.fn(async () => ({ status: "retired" as const })),
    restore: vi.fn(),
    discardDraft: vi.fn(),
    ...overrides,
  } as ServiceRepository;
}

const issues = (input: unknown) => {
  const result = validateServiceDocument(input);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
};

describe("a service's document", () => {
  it("accepts a category of the platform, hours, phone, WhatsApp, address and place", () => {
    expect(
      validateServiceDocument(
        doc({
          hours: { mode: "always", note: "" },
          location: { lat: -17.4, lng: -66.1 },
        }),
      ).ok,
    ).toBe(true);
  });

  it("turns an empty number into no number", () => {
    const result = validateServiceDocument(doc({ phone: "  ", whatsapp: "" }));
    expect(result.ok && [result.value.phone, result.value.whatsapp]).toEqual([null, null]);
  });

  it("refuses another category, a WhatsApp without its country code, words as a phone and other keys", () => {
    expect(issues(doc({ category: "bar" }))).toEqual(["category"]);
    expect(issues(doc({ whatsapp: "70000000" }))).toEqual(["whatsapp"]);
    expect(issues(doc({ phone: "llamar al 444" }))).toEqual(["phone"]);
    expect(issues(doc({ body: [] }))).toEqual([""]);
    expect(issues(doc({ address: "Calle 1\nCalle 2" }))).toEqual(["address"]);
  });

  it("needs an address or a place to be published", () => {
    expect(servicePublicationIssues(doc({ address: "", location: null }))).toEqual([
      { path: "address", code: "required" },
    ]);
    expect(servicePublicationIssues(doc({ address: "", location: { lat: 1, lng: 1 } }))).toEqual(
      [],
    );
    expect(servicePublicationIssues(doc())).toEqual([]);
  });
});

describe("the editors' use cases", () => {
  it("an editor saves, an analyst cannot", async () => {
    const repo = repository();
    expect((await saveServiceDraft(member("editor"), "s1", doc(), 1, repo)).status).toBe("saved");
    expect((await saveServiceDraft(member("analyst"), "s1", doc(), 1, repo)).status).toBe(
      "forbidden",
    );
    expect(repo.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("only owners and admins publish and retire", async () => {
    const repo = repository();
    expect((await publishService(member("editor"), "s1", doc(), 1, repo)).status).toBe("forbidden");
    expect((await retireService(member("editor"), "s1", repo)).status).toBe("forbidden");
    expect((await publishService(member("admin"), "s1", doc(), 1, repo)).status).toBe("published");
    expect((await retireService(member("owner"), "s1", repo)).status).toBe("retired");
    expect(repo.publish).toHaveBeenCalledWith("t1", "s1", 2);
  });

  it("says what is missing before touching the database", async () => {
    const repo = repository();
    const result = await publishService(
      member("owner"),
      "s1",
      doc({ address: "", location: null }),
      1,
      repo,
    );
    expect(result).toEqual({ status: "invalid", issues: [{ path: "address", code: "required" }] });
    expect(repo.saveDraft).not.toHaveBeenCalled();
  });

  it("lists published first, then drafts and retired, by name", async () => {
    const entry = (title: string, status: "draft" | "published" | "changed" | "retired") => ({
      contentId: title,
      slug: title,
      title,
      category: "food" as const,
      status,
      updatedAt: "2026-11-01T00:00:00Z",
      publishedAt: null,
    });
    const repo = repository({
      list: vi.fn(async () => [
        entry("Zeta", "retired"),
        entry("Beta", "draft"),
        entry("Alfa", "changed"),
        entry("Casa", "published"),
      ]),
    });
    expect((await listServices(member("analyst"), repo)).map((row) => row.title)).toEqual([
      "Alfa",
      "Casa",
      "Beta",
      "Zeta",
    ]);
  });
});

describe("the portal's services", () => {
  const service = (slug: string, category: "food" | "cash" | "other", place: boolean) => ({
    slug,
    title: slug,
    summary: "",
    category,
    hours: null,
    phone: null,
    whatsapp: null,
    address: "Calle 1",
    location: place ? { lat: -17.4, lng: -66.1 } : null,
  });

  it("groups them in the platform's order, without empty groups", () => {
    const groups = groupServices([
      service("cajero", "cash", false),
      service("casona", "food", true),
      service("otro", "other", true),
    ]);
    expect(groups.map((group) => [group.section, group.items.map((item) => item.slug)])).toEqual([
      ["Dónde comer", ["casona"]],
      ["Cajeros y bancos", ["cajero"]],
      ["Otros servicios", ["otro"]],
    ]);
  });

  it("puts on the map only those with a place", () => {
    expect(
      servicesOnMap([service("cajero", "cash", false), service("casona", "food", true)]).map(
        (item) => item.slug,
      ),
    ).toEqual(["casona"]);
  });

  it("calls and writes from the numbers", () => {
    expect(telHref("4 444-1234")).toBe("tel:44441234");
    expect(telHref("+591 4 4441234")).toBe("tel:+59144441234");
    expect(whatsappHref("+591 700 00000")).toBe("https://wa.me/59170000000");
  });
});

describe("the assistant and services", () => {
  const source = {
    source: "content" as const,
    kind: "service" as const,
    slug: "cajero",
    revisionNo: 1,
    title: "Cajero del banco",
    summary: "",
    body: [],
    timezone: "America/La_Paz",
    schedule: null,
    venueTitle: null,
    hours: { mode: "always" as const, note: "" },
    validity: null,
    placeTitle: null,
    service: { category: "cash" as const, phone: null, whatsapp: null, address: "Plaza 1" },
    story: null,
    visitMinutes: null,
    kids: null,
    document: null,
  };

  it("reads the category in words, the address and the hours, so «¿hay un cajero?» finds it", () => {
    const [unit] = contentUnits(source, null);
    const text = JSON.stringify(unit?.blocks);
    expect(text).toContain(SERVICE_CATEGORY_INFO.cash.words);
    expect(text).toContain("Dirección: Plaza 1.");
    expect(text).toContain("Horario de atención");
  });

  it("cites the card on /servicios", () => {
    const passage = {
      chunkId: "c1",
      source: "content",
      sourceId: "s1",
      sourceVersion: 1,
      kind: "service",
      slug: "cajero",
      title: "Cajero del banco",
      heading: null,
      text: "Cajero.",
      pages: null,
      sceneId: null,
      hotspotId: null,
      ended: false,
      score: 1,
    } satisfies KnowledgePassage;
    expect(publicCitation(passage)).toMatchObject({
      label: "Servicio",
      href: "/servicios#cajero",
    });
  });

  it("does not read a service without the module, and «Solo información» has it", () => {
    const passage = { source: "content" as const, kind: "service" };
    expect(passageVisibleWith(["agenda"], passage)).toBe(false);
    expect(passageVisibleWith(["services"], passage)).toBe(true);
    expect(MODULE_PACKAGES.information).toContain("services");
    expect(checkModuleSet(["services"])).toEqual({ status: "ok", modules: ["services"] });
  });
});
