import { describe, expect, it } from "vitest";

import type { OrganizationMembership } from "../../contracts/organization";
import {
  addEmbedOrigin,
  loadContentWebLink,
  removeEmbedOrigin,
  saveContentWebLink,
  type EmbedRepository,
  type PlatformEmbedRepository,
} from "./embed";

const TENANT = "5eed1000-0000-4000-8000-000000000002";
const ITEM = "5eed4300-0000-4000-8000-000000000001";

function member(role: OrganizationMembership["role"]): OrganizationMembership {
  return {
    tenantId: TENANT,
    slug: "demo-sur",
    displayName: "Municipio Demo Sur",
    tenantStatus: "active",
    role,
  } as OrganizationMembership;
}

function platform() {
  const calls: string[] = [];
  const repo: PlatformEmbedRepository = {
    list: async () => [],
    add: async (tenantId, origin) => {
      calls.push(`add:${tenantId}:${origin}`);
      return { status: "updated", origins: [origin] };
    },
    remove: async (tenantId, origin) => {
      calls.push(`remove:${tenantId}:${origin}`);
      return { status: "updated", origins: [] };
    },
  };
  return { repo, calls };
}

function embed(origins: string[], url: string | null = null) {
  const calls: string[] = [];
  const repo: EmbedRepository = {
    origins: async () => origins,
    webLink: async () => url,
    setWebLink: async (_tenantId, contentId, value) => {
      calls.push(`${contentId}:${value}`);
      return { status: "saved", url: value };
    },
  };
  return { repo, calls };
}

describe("the websites where the assistant may be embedded (ADR-071)", () => {
  it("adds a website as an origin, and refuses part of one before asking the database", async () => {
    const p = platform();
    expect(await addEmbedOrigin(p.repo, TENANT, "www.muni.gob.bo/")).toEqual({
      status: "updated",
      origins: ["https://www.muni.gob.bo"],
    });
    expect(await addEmbedOrigin(p.repo, TENANT, "https://www.muni.gob.bo/turismo")).toEqual({
      status: "invalid",
    });
    expect(await addEmbedOrigin(p.repo, "", "https://www.muni.gob.bo")).toEqual({
      status: "invalid",
    });
    expect(await removeEmbedOrigin(p.repo, TENANT, "https://www.muni.gob.bo")).toEqual({
      status: "updated",
      origins: [],
    });
    expect(p.calls).toEqual([
      `add:${TENANT}:https://www.muni.gob.bo`,
      `remove:${TENANT}:https://www.muni.gob.bo`,
    ]);
  });
});

describe("«Página en la web del municipio» (ADR-071)", () => {
  it("is offered only when the municipality has authorized websites", async () => {
    expect(await loadContentWebLink(member("owner"), ITEM, embed([]).repo)).toBeNull();
    expect(
      await loadContentWebLink(
        member("editor"),
        ITEM,
        embed(["https://www.muni.gob.bo"], null).repo,
      ),
    ).toEqual({ origins: ["https://www.muni.gob.bo"], url: null, canChange: false });
    expect(
      (await loadContentWebLink(member("admin"), ITEM, embed(["https://www.muni.gob.bo"]).repo))
        ?.canChange,
    ).toBe(true);
  });

  it("is set by owners and admins, only on an authorized website", async () => {
    const e = embed(["https://www.muni.gob.bo"]);
    expect(
      await saveContentWebLink(member("editor"), ITEM, "https://www.muni.gob.bo/museo", e.repo),
    ).toEqual({ status: "forbidden" });
    expect(
      await saveContentWebLink(member("owner"), ITEM, "https://otra.bo/museo", e.repo),
    ).toEqual({
      status: "origin",
    });
    expect(await saveContentWebLink(member("owner"), ITEM, "museo", e.repo)).toEqual({
      status: "invalid",
    });
    expect(
      await saveContentWebLink(member("owner"), ITEM, " https://www.muni.gob.bo/museo ", e.repo),
    ).toEqual({ status: "saved", url: "https://www.muni.gob.bo/museo" });
    expect(await saveContentWebLink(member("admin"), ITEM, "", e.repo)).toEqual({
      status: "saved",
      url: null,
    });
    expect(e.calls).toEqual([`${ITEM}:https://www.muni.gob.bo/museo`, `${ITEM}:null`]);
  });
});
