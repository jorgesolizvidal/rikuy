import type { EventDocument } from "../../contracts/event";
import type { OrganizationMembership } from "../../contracts/organization";
import { parseMarkup } from "../../domain/content/markup";
import { createDestination, saveDestinationDraft } from "../content/destinations";
import { createEvent, publishEvent } from "../content/events";
import type { ContentRepository } from "../content/ports";
import { createKnowledge, publishKnowledge } from "../knowledge/knowledge";
import type { KnowledgeRepository } from "../knowledge/ports";
import type { MediaAdmin } from "../media/ports";
import type { TRAP_KEYS } from "./fixtures-data";
import { TRAP_DRAFT, TRAP_EVENT, TRAP_HISTORY, TRAP_NOTICE } from "./fixtures-data";

/**
 * «Preparar los datos de prueba» (ADR-045): the trap data in demo B, through the panel's own
 * use cases (same authorization, validation and audit). Running it again republishes what
 * was retired and leaves alone what is already there. Only the owner or an administrator of
 * a commercial demo can do it — never in the demo shown to clients, which the page does not
 * offer as B.
 */

export interface FixtureDeps {
  readonly content: ContentRepository;
  readonly knowledge: KnowledgeRepository;
  readonly admin: Pick<MediaAdmin, "publish">;
  readonly now: () => Date;
}

export type FixtureKey = keyof typeof TRAP_KEYS;

export interface FixtureState {
  readonly key: FixtureKey;
  readonly title: string;
  /** published (draft for the draft trap) · missing · retired. */
  readonly status: "ready" | "missing" | "retired";
  /** The assistant already read it (published items only; null for the draft). */
  readonly indexed: boolean | null;
}

export type PrepareFixturesResult =
  | { readonly status: "prepared"; readonly fixtures: readonly FixtureState[] }
  | { readonly status: "not_demo" | "forbidden" | "no_place" | "failed" };

const ROLES = new Set(["owner", "admin"]);

function allowed(membership: OrganizationMembership): "ok" | "not_demo" | "forbidden" {
  if (membership.demo !== true) return "not_demo";
  return ROLES.has(membership.role) ? "ok" : "forbidden";
}

function richText(text: string) {
  return parseMarkup(text).blocks;
}

/** `YYYY-MM-DD`, some days before `now` (UTC dates; the event is days in the past anyway). */
function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

async function publishTrapKnowledge(
  membership: OrganizationMembership,
  item: typeof TRAP_NOTICE | typeof TRAP_HISTORY,
  deps: FixtureDeps,
): Promise<boolean> {
  const existing = (await deps.knowledge.list(membership.tenantId)).find(
    (entry) => entry.slug === item.slug,
  );
  if (existing?.status === "published") return true;
  let contentId = existing?.contentId;
  if (!contentId) {
    const created = await createKnowledge(
      membership,
      { title: item.title, slug: item.slug },
      deps.knowledge,
    );
    if (created.status !== "created") return false;
    contentId = created.contentId;
  }
  const record = await deps.knowledge.find(membership.tenantId, contentId);
  const published = await publishKnowledge(
    membership,
    contentId,
    { title: item.title, summary: item.summary, body: richText(item.body), document: null },
    record?.draft?.editCount ?? null,
    deps.knowledge,
  );
  return published.status === "published";
}

export async function prepareEvalFixtures(
  membership: OrganizationMembership,
  deps: FixtureDeps,
): Promise<PrepareFixturesResult> {
  const may = allowed(membership);
  if (may !== "ok") return { status: may };
  const tenantId = membership.tenantId;

  // The ended event sits at demo B's own plaza (the sample content must be loaded).
  const destinations = await deps.content.listDestinations(tenantId);
  const plaza = destinations.find((entry) => entry.slug === "plaza-principal");
  const plazaRecord = plaza ? await deps.content.findDestination(tenantId, plaza.contentId) : null;
  const location = plazaRecord?.published?.document.location ?? null;
  if (!plaza || location === null) return { status: "no_place" };

  if (!(await publishTrapKnowledge(membership, TRAP_NOTICE, deps))) return { status: "failed" };
  if (!(await publishTrapKnowledge(membership, TRAP_HISTORY, deps))) return { status: "failed" };

  const events = await deps.content.listEvents(tenantId);
  const event = events.find((entry) => entry.slug === TRAP_EVENT.slug);
  if (!event || event.status === "draft" || event.publishedAt === null) {
    let contentId = event?.contentId;
    if (!contentId) {
      const created = await createEvent(
        membership,
        { title: TRAP_EVENT.title, slug: TRAP_EVENT.slug },
        deps.content,
      );
      if (created.status !== "created") return { status: "failed" };
      contentId = created.contentId;
    }
    const record = await deps.content.findEvent(tenantId, contentId);
    const day = daysAgo(deps.now(), TRAP_EVENT.daysAgo);
    const document: EventDocument = {
      title: TRAP_EVENT.title,
      summary: TRAP_EVENT.summary,
      body: richText(TRAP_EVENT.body),
      location,
      cover: null,
      gallery: [],
      schedule: {
        allDay: false,
        start: `${day}T${TRAP_EVENT.start}`,
        end: `${day}T${TRAP_EVENT.end}`,
      },
      venueId: plaza.contentId,
    };
    const published = await publishEvent(
      membership,
      contentId,
      document,
      record?.draft?.editCount ?? null,
      deps.content,
      deps.admin,
    );
    if (published.status !== "published") return { status: "failed" };
  }

  if (!destinations.some((entry) => entry.slug === TRAP_DRAFT.slug)) {
    const created = await createDestination(
      membership,
      { title: TRAP_DRAFT.title, slug: TRAP_DRAFT.slug },
      deps.content,
    );
    if (created.status !== "created") return { status: "failed" };
    const record = await deps.content.findDestination(tenantId, created.contentId);
    const saved = await saveDestinationDraft(
      membership,
      created.contentId,
      {
        title: TRAP_DRAFT.title,
        summary: TRAP_DRAFT.summary,
        body: richText(TRAP_DRAFT.body),
        location: null,
        cover: null,
        gallery: [],
      },
      record?.draft?.editCount ?? null,
      deps.content,
    );
    if (saved.status !== "saved") return { status: "failed" };
  }
  return { status: "prepared", fixtures: await evalFixtureStates(membership, deps) };
}

/** Where each trap stands in demo B, for the page (any member may read it). */
export async function evalFixtureStates(
  membership: OrganizationMembership,
  deps: Pick<FixtureDeps, "content" | "knowledge">,
): Promise<FixtureState[]> {
  const tenantId = membership.tenantId;
  const [knowledge, events, destinations, index] = await Promise.all([
    deps.knowledge.list(tenantId),
    deps.content.listEvents(tenantId),
    deps.content.listDestinations(tenantId),
    deps.knowledge.indexStatus(tenantId),
  ]);
  const indexed = (slug: string) =>
    index.some((entry) => entry.slug === slug && entry.chunks !== null && entry.chunks > 0);
  const knowledgeState = (key: FixtureKey, item: { slug: string; title: string }): FixtureState => {
    const entry = knowledge.find((row) => row.slug === item.slug);
    const status = !entry
      ? "missing"
      : entry.status === "published" || entry.status === "changed"
        ? "ready"
        : "retired";
    return {
      key,
      title: item.title,
      status,
      indexed: status === "ready" ? indexed(item.slug) : null,
    };
  };
  const event = events.find((row) => row.slug === TRAP_EVENT.slug);
  const eventStatus = !event ? "missing" : event.publishedAt !== null ? "ready" : "retired";
  const draft = destinations.find((row) => row.slug === TRAP_DRAFT.slug);
  return [
    knowledgeState("notice", TRAP_NOTICE),
    knowledgeState("history", TRAP_HISTORY),
    {
      key: "event",
      title: TRAP_EVENT.title,
      status: eventStatus,
      indexed: eventStatus === "ready" ? indexed(TRAP_EVENT.slug) : null,
    },
    { key: "draft", title: TRAP_DRAFT.title, status: draft ? "ready" : "missing", indexed: null },
  ];
}

/** Every trap is in place and the assistant read the published ones. */
export function fixturesReady(states: readonly FixtureState[]): boolean {
  return states.every((state) => state.status === "ready" && state.indexed !== false);
}
