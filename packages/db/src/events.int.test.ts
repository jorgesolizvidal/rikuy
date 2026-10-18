/**
 * Events against a REAL local Supabase stack: an editor writes an event at a destination,
 * an owner publishes it and visitors see it on the agenda; an event that ends leaves the
 * agenda by itself; another municipality's destination is not a valid venue.
 */
import {
  createEvent,
  loadAgenda,
  loadEventEditor,
  publishEvent,
  saveEventDraft,
  type EventDocument,
  type OrganizationMembership,
} from "@rikuy/core";
import { beforeAll, describe, expect, it } from "vitest";

import { createContentRepository, createSupabasePublishedEventReader } from "./content";
import { env, signIn, stackAvailable, USERS } from "./integration/local-stack";
import { createSupabaseMediaAdmin } from "./media";

const NORTE = "5eed1000-0000-4000-8000-000000000001";
const SUR = "5eed1000-0000-4000-8000-000000000002";
const MIRADOR = "5eed4100-0000-4000-8000-000000000001"; // Norte destination (seed)
const LAGUNA = "5eed4100-0000-4000-8000-000000000003"; // Sur destination (seed)

async function membershipOf(session: Awaited<ReturnType<typeof signIn>>, tenantId: string) {
  const memberships = await session.reader.listActiveMemberships(session.actor.userId);
  const membership = memberships.find((m) => m.tenantId === tenantId);
  if (!membership) throw new Error(`no membership in ${tenantId}`);
  return membership;
}

/** Local wall-clock of the seed tenants (America/La_Paz has no DST: UTC−4). */
function local(offsetMs: number, allDay: boolean): string {
  const value = new Date(Date.now() - 4 * 3_600_000 + offsetMs).toISOString();
  return allDay ? value.slice(0, 10) : value.slice(0, 16);
}

describe.runIf(stackAvailable)("events against local Supabase", () => {
  let editorNorte: OrganizationMembership;
  let ownerNorte: OrganizationMembership;
  let editorContent: ReturnType<typeof createContentRepository>;
  let ownerContent: ReturnType<typeof createContentRepository>;
  const visitors = () =>
    createSupabasePublishedEventReader({ url: env.url, publishableKey: env.publishableKey });

  beforeAll(async () => {
    const editor = await signIn(USERS.both);
    const owner = await signIn(USERS.ownerNorte);
    editorNorte = await membershipOf(editor, NORTE);
    ownerNorte = await membershipOf(owner, NORTE);
    editorContent = createContentRepository(editor.client);
    ownerContent = createContentRepository(owner.client);
  });

  it("draft → publish → on the agenda; ended events leave it by themselves", async () => {
    const admin = createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey });
    const slug = `evento-${Date.now()}`;
    const created = await createEvent(
      editorNorte,
      { title: "Evento de integración", slug },
      editorContent,
    );
    if (created.status !== "created") throw new Error(`create: ${created.status}`);

    const editor = await loadEventEditor(editorNorte, created.contentId, editorContent);
    expect(editor?.document.schedule).toBeNull();
    const upcoming: EventDocument = {
      title: "Evento de integración",
      summary: "Un evento para probar la agenda.",
      body: [],
      location: { lat: -17.39, lng: -66.15 },
      cover: null,
      gallery: [],
      schedule: { allDay: false, start: local(3_600_000, false), end: local(7_200_000, false) },
      venueId: MIRADOR,
    };
    const saved = await saveEventDraft(editorNorte, created.contentId, upcoming, 1, editorContent);
    if (saved.status !== "saved") throw new Error(`save: ${saved.status}`);
    expect(await visitors().find(NORTE, slug)).toBeNull();

    expect(
      await publishEvent(
        ownerNorte,
        created.contentId,
        upcoming,
        saved.editCount,
        ownerContent,
        admin,
      ),
    ).toEqual({ status: "published", revisionNo: 1 });
    const listed = (await visitors().list(NORTE)).find((event) => event.slug === slug);
    expect(listed?.venue).toEqual({ slug: "mirador-del-valle", title: "Mirador del Valle" });
    expect(new Date(listed?.startsAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    expect(await visitors().find(SUR, slug)).toBeNull();

    // Republish it as already over (ended an hour ago, local time).
    const over: EventDocument = {
      ...upcoming,
      schedule: { allDay: false, start: local(-7_200_000, false), end: local(-3_600_000, false) },
    };
    const draft = await saveEventDraft(ownerNorte, created.contentId, over, null, ownerContent);
    if (draft.status !== "saved") throw new Error(`save 2: ${draft.status}`);
    await publishEvent(ownerNorte, created.contentId, over, draft.editCount, ownerContent, admin);
    expect((await visitors().list(NORTE)).some((event) => event.slug === slug)).toBe(false);
    expect((await visitors().find(NORTE, slug))?.ended).toBe(true);

    const agenda = await loadAgenda(editorNorte, editorContent);
    expect(agenda.past.some((event) => event.slug === slug)).toBe(true);
    expect(agenda.upcoming.some((event) => event.slug === "feria-del-choclo")).toBe(true);
  });

  it("another municipality's destination is not a valid venue", async () => {
    const created = await createEvent(
      editorNorte,
      { title: "Venue ajeno", slug: `venue-${Date.now()}` },
      editorContent,
    );
    if (created.status !== "created") throw new Error(`create: ${created.status}`);
    expect(
      await saveEventDraft(
        editorNorte,
        created.contentId,
        {
          title: "Venue ajeno",
          summary: "",
          body: [],
          location: null,
          cover: null,
          gallery: [],
          schedule: null,
          venueId: LAGUNA,
        },
        1,
        editorContent,
      ),
    ).toEqual({ status: "invalid", issues: [{ path: "venueId", code: "invalid" }] });
  });
});
