import type { AiRefusal } from "../../contracts/ai";
import {
  CONTENT_PROPOSAL_FIELDS,
  COPILOT_LIMITS,
  PROPOSAL_STYLES,
  SCENE_PROPOSAL_FIELDS,
  type CopilotAnswer,
  type CopilotReviewRow,
  type CopilotSnapshotRow,
  type CopilotSourceLink,
  type CopilotTurn,
  type ProposalField,
  type ProposalListEntry,
  type ProposalSource,
  type ProposalStyle,
  type ProposalTarget,
  type ProposalView,
} from "../../contracts/copilot";
import type { DestinationDocument } from "../../contracts/destination";
import type { EventDocument } from "../../contracts/event";
import type { KnowledgePassage } from "../../contracts/knowledge";
import type { OrganizationMembership } from "../../contracts/organization";
import { richTextToPlainText, type RichText } from "../../contracts/rich-text";
import { excerpt } from "../../domain/assistant/prompts";
import { richTextToMarkup } from "../../domain/content/markup";
import { COPILOT_ISSUE_LABELS } from "../../domain/copilot/issues";
import { linksOf, parseCopilotAnswer, parseProposal } from "../../domain/copilot/parse";
import { COPILOT_PATHS } from "../../domain/copilot/paths";
import {
  copilotAskMessages,
  copilotProposeMessages,
  trimTurns,
  type CopilotSnapshot,
  type SnapshotItem,
} from "../../domain/copilot/prompts";
import { formatEventSchedule } from "../../domain/events/schedule";
import type { AiCall, AiSessionInput, AiSessionResult } from "../ai/gateway";
import { reservationFor } from "../ai/gateway";
import type { ContentRecord, ContentRepository } from "../content/ports";
import type { KnowledgeRepository } from "../knowledge/ports";
import type { TourRepository } from "../tours/tours";
import type { UsageMeter } from "../usage/usage";
import type { CopilotRepository } from "./ports";

/**
 * The staff's Copilot (P5 · Paso 7, ADR-042, ADR-008).
 *
 * - V1: the content review (fixed rules) and questions answered from an authorized snapshot
 *   of the municipality's content (drafts included), its plan's usage and its published
 *   passages. Any member.
 * - V2: proposals for the texts of one destination, event or tour scene, saved with their
 *   base and diff; accepted field by field into a DRAFT. Editors and above.
 *
 * The model never decides the municipality nor the permissions: every read is the signed-in
 * person's session, and every write is an RPC that re-checks the role and the base.
 */

const EDITING_ROLES = new Set(["owner", "admin", "editor"]);

export function canPropose(membership: OrganizationMembership): boolean {
  return EDITING_ROLES.has(membership.role);
}

/** Runs one request of the AI gateway (the web's runAiWork, ADR-036). */
export type CopilotAiRunner = <T>(
  input: AiSessionInput,
  work: (call: AiCall) => Promise<T>,
) => Promise<AiSessionResult<T>>;

/** What the staff reads when the model cannot answer: never an error page. */
export const COPILOT_NOTICES: Readonly<Record<AiRefusal | "nothing", string>> = {
  tenant_quota:
    "El municipio usó su cuota de IA de hoy. Se renueva a medianoche; mientras tanto, la revisión del contenido sigue funcionando.",
  platform_quota:
    "La plataforma usó su cuota de IA de hoy. Prueba mañana; la revisión del contenido sigue funcionando.",
  visitor_limit: "Hiciste muchas consultas seguidas. Prueba en unos minutos.",
  tenant_unavailable: "El municipio está suspendido: el Copilot no responde.",
  provider_unavailable: "El servicio de IA no responde ahora. Prueba en unos minutos.",
  provider_error: "El Copilot no pudo responder esta vez. Prueba de nuevo.",
  not_configured: "El Copilot no está disponible en esta plataforma por ahora.",
  nothing:
    "El Copilot no encontró nada nuevo que proponer con la información publicada. Puedes pedirlo con otras palabras o escribirlo en el editor.",
};

function today(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("es", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

// ── V1: the review ─────────────────────────────────────────────────────────

export interface CopilotOverview {
  readonly review: readonly CopilotReviewRow[];
  /** Null for analysts (they read; they do not propose). */
  readonly proposals: readonly ProposalListEntry[] | null;
}

export async function loadCopilot(
  membership: OrganizationMembership,
  copilot: CopilotRepository,
): Promise<CopilotOverview> {
  const [review, proposals] = await Promise.all([
    copilot.review(membership.tenantId),
    canPropose(membership) ? copilot.listProposals(membership.tenantId) : Promise.resolve(null),
  ]);
  return { review, proposals };
}

// ── V1: questions ──────────────────────────────────────────────────────────

const KIND_NAMES = { destination: "Destino", event: "Evento" } as const;
const STATE_NAMES = {
  draft: "borrador, nunca publicado",
  published: "publicado",
  changed: "publicado, con cambios sin publicar",
} as const;

function snapshotItems(
  rows: readonly CopilotSnapshotRow[],
  review: readonly CopilotReviewRow[],
): { items: SnapshotItem[]; byLabel: Map<string, CopilotSnapshotRow>; omitted: number } {
  const byLabel = new Map<string, CopilotSnapshotRow>();
  const kept = rows.slice(0, COPILOT_LIMITS.snapshotItems);
  const items = kept.map((row, index) => {
    const label = `C${index + 1}`;
    byLabel.set(label, row);
    const findings = review
      .filter((entry) => entry.contentId === row.contentId)
      .flatMap((entry) =>
        entry.sceneId
          ? [`escena «${entry.sceneTitle ?? ""}» del tour sin descripción`]
          : entry.issues
              .filter((issue) => issue !== "never_published" && issue !== "unpublished_changes")
              .map((issue) => COPILOT_ISSUE_LABELS[issue].toLowerCase()),
      );
    const details: string[] = [];
    if (row.schedule) {
      details.push(
        `Fecha: ${formatEventSchedule(row.schedule)}${row.ended ? " (ya terminó)" : ""}`,
      );
    }
    details.push(
      row.tour
        ? `Tour 360°: ${STATE_NAMES[row.tour.status]}, ${row.tour.scenes} escena${row.tour.scenes === 1 ? "" : "s"}`
        : "Tour 360°: no tiene",
    );
    return {
      label,
      name: `${KIND_NAMES[row.kind]} «${row.title}»`,
      state: STATE_NAMES[row.status],
      summary: excerpt(row.summary, 200),
      details,
      findings,
    };
  });
  return { items, byLabel, omitted: rows.length - kept.length };
}

function megabytes(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${value.toLocaleString("es", { maximumFractionDigits: value < 10 ? 1 : 0 })} MB`;
}

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60).toLocaleString("es")} min`;
}

/** The plan's usage in words, from the meters the database computed (never the model). */
export function usageLines(input: {
  readonly meters: readonly UsageMeter[];
  readonly ai: { readonly used: number; readonly limit: number } | null;
}): string[] {
  const lines: string[] = [];
  for (const meter of input.meters) {
    const used = meter.consumed + meter.reserved;
    if (meter.resource === "storage_bytes") {
      lines.push(`Almacenamiento: ${megabytes(used)} de ${megabytes(meter.limit)}.`);
    } else if (meter.resource === "media_compute_seconds") {
      lines.push(`Procesamiento de medios este mes: ${minutes(used)} de ${minutes(meter.limit)}.`);
    }
  }
  if (input.ai) {
    lines.push(
      `IA hoy: ${input.ai.used.toLocaleString("es")} de ${input.ai.limit.toLocaleString("es")} tokens.`,
    );
  }
  lines.push(
    "Visitas y preguntas de los visitantes: están en «Estadísticas», con las recomendaciones del Copilot (este chat no las lee).",
  );
  return lines;
}

export interface CopilotAskDeps {
  readonly copilot: CopilotRepository;
  readonly knowledge: KnowledgeRepository;
  /** The plan's usage in words (usageLines). */
  readonly usage: () => Promise<string[]>;
  readonly ai: CopilotAiRunner;
  readonly now?: () => Date;
}

export interface CopilotAskInput {
  readonly question: unknown;
  readonly history?: unknown;
}

function parseTurns(value: unknown): CopilotTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: CopilotTurn[] = [];
  for (const item of value.slice(-COPILOT_LIMITS.history)) {
    const turn = item as { role?: unknown; text?: unknown } | null;
    if (
      turn &&
      (turn.role === "user" || turn.role === "assistant") &&
      typeof turn.text === "string" &&
      turn.text.trim()
    ) {
      turns.push({ role: turn.role, text: turn.text });
    }
  }
  return trimTurns(turns);
}

function sourceLinks(
  org: string,
  labels: readonly string[],
  byLabel: ReadonlyMap<string, CopilotSnapshotRow>,
  passages: readonly KnowledgePassage[],
): CopilotSourceLink[] {
  const links: CopilotSourceLink[] = [];
  const seen = new Set<string>();
  const add = (link: CopilotSourceLink) => {
    const key = `${link.href ?? ""}|${link.title}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };
  for (const label of labels) {
    if (label === "U") {
      add({ label: "Uso del plan", title: "Uso del plan", href: COPILOT_PATHS.usage(org) });
      continue;
    }
    const row = byLabel.get(label);
    if (row) {
      add({
        label: KIND_NAMES[row.kind],
        title: row.title,
        href: COPILOT_PATHS.editor(org, row.kind, row.contentId),
      });
      continue;
    }
    if (label.startsWith("F")) {
      const passage = passages[Number(label.slice(1)) - 1];
      if (!passage) continue;
      const href =
        passage.source === "tour"
          ? COPILOT_PATHS.tour(org, passage.sourceId)
          : passage.kind === "knowledge"
            ? COPILOT_PATHS.knowledge(org, passage.sourceId)
            : COPILOT_PATHS.editor(org, passage.kind, passage.sourceId);
      add({
        label:
          passage.source === "tour"
            ? "Tour 360°"
            : passage.kind === "knowledge"
              ? "Documento"
              : KIND_NAMES[passage.kind],
        title: passage.heading ? `${passage.title} · ${passage.heading}` : passage.title,
        href,
      });
    }
    // Any other label points nowhere: dropped (an invented source).
  }
  return links;
}

/** What happened inside a Copilot request, for the evaluation (ADR-045); never shown. */
export interface CopilotTrace {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  /** Labels the model wrote that point nowhere (dropped). */
  readonly invented: number;
}

const NO_TRACE: CopilotTrace = { inputTokens: 0, outputTokens: 0, latencyMs: 0, invented: 0 };

/** V1: a question of the staff about their municipality's content. Any member. */
export async function askCopilot(
  membership: OrganizationMembership,
  actorId: string,
  input: CopilotAskInput,
  deps: CopilotAskDeps,
): Promise<CopilotAnswer> {
  return (await askCopilotTraced(membership, actorId, input, deps)).answer;
}

export async function askCopilotTraced(
  membership: OrganizationMembership,
  actorId: string,
  input: CopilotAskInput,
  deps: CopilotAskDeps,
): Promise<{ readonly answer: CopilotAnswer; readonly trace: CopilotTrace }> {
  const question =
    typeof input.question === "string" ? input.question.replace(/\s+/gu, " ").trim() : "";
  if (question.length < 2 || question.length > COPILOT_LIMITS.question) {
    return { answer: { status: "invalid" }, trace: NO_TRACE };
  }
  const history = parseTurns(input.history);
  const now = (deps.now ?? (() => new Date()))();

  const [data, review, usage, passages] = await Promise.all([
    deps.copilot.snapshot(membership.tenantId),
    deps.copilot.review(membership.tenantId),
    deps.usage(),
    deps.knowledge.search(membership.tenantId, question.slice(0, 300), COPILOT_LIMITS.passages),
  ]);
  const { items, byLabel, omitted } = snapshotItems(data.items, review);
  const snapshot: CopilotSnapshot = {
    site: membership.displayName,
    today: today(now, data.timezone),
    items,
    omitted,
    usage,
  };
  const messages = copilotAskMessages({ snapshot, passages, history, question });
  const result = await deps.ai(
    {
      tenantId: membership.tenantId,
      profile: "copilot",
      reserveTokens: reservationFor("copilot", messages),
      actorId,
    },
    async (call) => (await call({ messages })).text,
  );
  if (result.outcome !== "answered") {
    return {
      answer: { status: "notice", message: COPILOT_NOTICES[result.outcome] },
      trace: NO_TRACE,
    };
  }
  const trace = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    latencyMs: result.latencyMs,
  };
  const parsed = parseCopilotAnswer(result.value);
  if (parsed.blocks.length === 0) {
    return {
      answer: { status: "notice", message: COPILOT_NOTICES.provider_error },
      trace: { ...trace, invented: 0 },
    };
  }
  const sources = sourceLinks(membership.slug, parsed.labels, byLabel, passages);
  const invented = parsed.labels.filter(
    (label) =>
      label !== "U" &&
      !byLabel.has(label) &&
      !(label.startsWith("F") && passages[Number(label.slice(1)) - 1]),
  ).length;
  return {
    answer: { status: "answered", blocks: parsed.blocks, sources },
    trace: { ...trace, invented },
  };
}

// ── V2: proposals ──────────────────────────────────────────────────────────

export interface ProposeInput {
  readonly target: ProposalTarget;
  readonly fields: unknown;
  readonly style: unknown;
  readonly words?: unknown;
}

export type ProposeOutcome =
  | { readonly status: "created"; readonly proposalId: string }
  | { readonly status: "notice"; readonly message: string }
  | { readonly status: "invalid" | "forbidden" | "not_found" | "stale" };

export interface CopilotProposeDeps {
  readonly copilot: CopilotRepository;
  readonly content: ContentRepository;
  readonly tours: TourRepository;
  readonly knowledge: KnowledgeRepository;
  readonly ai: CopilotAiRunner;
  readonly now?: () => Date;
}

/** The base of a proposal and everything the model reads about it. */
export interface ProposalBase {
  /** What the proposal is for (a scene belongs to the tour of this item). */
  readonly kind: "destination" | "event";
  readonly baseRevisionId: string;
  readonly baseEdit: number | null;
  /** «Destino «Museo»» or «Escena «Sala» del tour 360° de «Museo»». */
  readonly name: string;
  readonly title: string;
  readonly current: Readonly<Partial<Record<ProposalField, string | RichText>>>;
  readonly context: readonly string[];
  /** Words to look for published passages about it. */
  readonly search: string;
}

async function contentRecord(
  tenantId: string,
  contentId: string,
  content: ContentRepository,
): Promise<{
  readonly kind: "destination" | "event";
  readonly record: ContentRecord<DestinationDocument | EventDocument>;
} | null> {
  const destination = await content.findDestination(tenantId, contentId);
  if (destination) return { kind: "destination", record: destination };
  const event = await content.findEvent(tenantId, contentId);
  return event ? { kind: "event", record: event } : null;
}

function documentText(document: DestinationDocument | EventDocument): string {
  return excerpt(richTextToPlainText(document.body), 1500);
}

/** Reads what the proposal is about, from the editor's own data (the person's session). */
export async function loadProposalBase(
  membership: OrganizationMembership,
  target: ProposalTarget,
  deps: Pick<CopilotProposeDeps, "content" | "tours">,
): Promise<ProposalBase | null> {
  if (target.type === "content") {
    const found = await contentRecord(membership.tenantId, target.contentId, deps.content);
    if (!found) return null;
    const { record, kind } = found;
    const base = record.draft
      ? {
          revisionId: record.draft.revisionId,
          edit: record.draft.editCount,
          document: record.draft.document,
        }
      : record.published
        ? {
            revisionId: record.published.revisionId,
            edit: null,
            document: record.published.document,
          }
        : null;
    if (!base) return null;
    const document = base.document as DestinationDocument | EventDocument;
    const context: string[] = [];
    if (kind === "event" && "schedule" in document && document.schedule) {
      context.push(`Fecha: ${formatEventSchedule(document.schedule)}`);
    }
    return {
      kind,
      baseRevisionId: base.revisionId,
      baseEdit: base.edit,
      name: `${KIND_NAMES[kind]} «${document.title}»`,
      title: document.title,
      current: { title: document.title, summary: document.summary, body: document.body },
      context,
      search: document.title,
    };
  }

  const tour = await deps.tours.find(membership.tenantId, target.tourId);
  if (!tour) return null;
  const revision = tour.draft ?? tour.published;
  const scene = revision?.scenes.find((item) => item.sceneId === target.sceneId);
  if (!revision || !scene) return null;
  const context: string[] = [];
  const item = await contentRecord(membership.tenantId, tour.content.contentId, deps.content);
  const itemDocument = (item?.record.draft ?? item?.record.published)?.document as
    DestinationDocument | EventDocument | undefined;
  if (itemDocument) {
    if (itemDocument.summary) context.push(`Resumen del lugar: ${itemDocument.summary}`);
    const text = documentText(itemDocument);
    if (text) context.push(`Texto del lugar:\n${text}`);
  }
  const others = revision.scenes.filter((other) => other.sceneId !== scene.sceneId);
  if (others.length > 0) {
    context.push(
      `Otras escenas del recorrido: ${others.map((other) => `«${other.title}»`).join(", ")}`,
    );
  }
  for (const hotspot of scene.hotspots) {
    if (hotspot.kind === "info") {
      const body = excerpt(richTextToPlainText(hotspot.body), 400);
      context.push(
        `Punto de información en esta escena: «${hotspot.title}»${body ? `: ${body}` : ""}`,
      );
    } else if (hotspot.kind === "model") {
      const body = excerpt(richTextToPlainText(hotspot.body), 300);
      context.push(`Modelo 3D en esta escena: «${hotspot.title}»${body ? `: ${body}` : ""}`);
    } else if (hotspot.kind === "tour" && hotspot.target) {
      context.push(`Desde esta escena se puede ir al recorrido de «${hotspot.target.title}».`);
    }
  }
  return {
    kind: tour.content.kind,
    baseRevisionId: revision.revisionId,
    baseEdit: tour.draft ? tour.draft.editCount : null,
    name: `Escena «${scene.title}» del tour 360° de «${tour.content.title}»`,
    title: scene.title,
    current: { title: scene.title, description: scene.description },
    context,
    search: `${tour.content.title} ${scene.title}`,
  };
}

export function proposalFieldsFor(target: ProposalTarget): readonly ProposalField[] {
  return target.type === "content" ? CONTENT_PROPOSAL_FIELDS : SCENE_PROPOSAL_FIELDS;
}

function parseFields(value: unknown, target: ProposalTarget): ProposalField[] | null {
  const allowed = proposalFieldsFor(target);
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const fields = allowed.filter((field) => list.includes(field));
  return fields.length > 0 && fields.length === list.length ? fields : null;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const PASSAGE_LABELS = { destination: "Destino", event: "Evento", knowledge: "Documento" } as const;

/** V2: the model proposes the asked texts; the proposal is saved for the staff to decide. */
export async function proposeWithCopilot(
  membership: OrganizationMembership,
  actorId: string,
  input: ProposeInput,
  deps: CopilotProposeDeps,
): Promise<ProposeOutcome> {
  return (await proposeWithCopilotTraced(membership, actorId, input, deps)).outcome;
}

export async function proposeWithCopilotTraced(
  membership: OrganizationMembership,
  actorId: string,
  input: ProposeInput,
  deps: CopilotProposeDeps,
): Promise<{ readonly outcome: ProposeOutcome; readonly trace: CopilotTrace }> {
  const done = (outcome: ProposeOutcome, trace: CopilotTrace = NO_TRACE) => ({ outcome, trace });
  if (!canPropose(membership)) return done({ status: "forbidden" });
  const fields = parseFields(input.fields, input.target);
  const style = PROPOSAL_STYLES.find((item) => item === input.style) as ProposalStyle | undefined;
  const words = typeof input.words === "string" ? input.words.replace(/\s+/gu, " ").trim() : "";
  if (!fields || !style || words.length > COPILOT_LIMITS.instruction) {
    return done({ status: "invalid" });
  }

  const base = await loadProposalBase(membership, input.target, deps);
  if (!base) return done({ status: "not_found" });
  const passages = await deps.knowledge.search(
    membership.tenantId,
    base.search.slice(0, 300),
    COPILOT_LIMITS.passages,
  );
  const current = Object.fromEntries(
    fields.map((field) => {
      const value = base.current[field];
      return [field, Array.isArray(value) ? richTextToMarkup(value) : (value ?? "")];
    }),
  );
  const messages = copilotProposeMessages({
    site: membership.displayName,
    target: base.name,
    fields,
    current,
    context: base.context,
    passages,
    style,
    words,
  });
  const allowedLinks = Array.isArray(base.current.body)
    ? linksOf(base.current.body as RichText)
    : new Set<string>();
  const result = await deps.ai(
    {
      tenantId: membership.tenantId,
      profile: "copilot",
      reserveTokens: reservationFor("copilot", messages),
      actorId,
    },
    async (call) => parseProposal((await call({ messages })).text, fields, { allowedLinks }),
  );
  if (result.outcome !== "answered") {
    return done({ status: "notice", message: COPILOT_NOTICES[result.outcome] });
  }
  const trace: CopilotTrace = {
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    latencyMs: result.latencyMs,
    invented: result.value.labels.filter(
      (label) => !(label.startsWith("F") && passages[Number(label.slice(1)) - 1]),
    ).length,
  };

  const changes = Object.fromEntries(
    Object.entries(result.value.values).filter(
      ([field, value]) => !sameValue(value, base.current[field as ProposalField]),
    ),
  );
  if (Object.keys(changes).length === 0) {
    return done({ status: "notice", message: COPILOT_NOTICES.nothing }, trace);
  }
  const sources: ProposalSource[] = [];
  for (const label of result.value.labels) {
    const passage = label.startsWith("F") ? passages[Number(label.slice(1)) - 1] : undefined;
    if (!passage || sources.length >= 8) continue;
    const title = (passage.heading ? `${passage.title} · ${passage.heading}` : passage.title).slice(
      0,
      200,
    );
    const label2 = passage.source === "tour" ? "Tour 360°" : PASSAGE_LABELS[passage.kind];
    if (!sources.some((source) => source.title === title)) sources.push({ label: label2, title });
  }

  const created = await deps.copilot.createProposal({
    tenantId: membership.tenantId,
    target: input.target,
    baseRevisionId: base.baseRevisionId,
    baseEdit: base.baseEdit,
    changes,
    sources,
    instruction: words,
    aiRequestId: result.requestId,
  });
  if (created.status === "created") {
    return done({ status: "created", proposalId: created.proposalId }, trace);
  }
  if (created.status === "unchanged") {
    return done({ status: "notice", message: COPILOT_NOTICES.nothing }, trace);
  }
  return done({ status: created.status }, trace);
}

export async function loadProposal(
  membership: OrganizationMembership,
  proposalId: string,
  copilot: CopilotRepository,
): Promise<ProposalView | null> {
  if (!canPropose(membership)) return null;
  return copilot.proposal(membership.tenantId, proposalId);
}

export async function acceptProposal(
  membership: OrganizationMembership,
  input: { readonly proposalId: unknown; readonly fields: unknown },
  copilot: CopilotRepository,
) {
  if (!canPropose(membership)) return { status: "forbidden" as const };
  const list = Array.isArray(input.fields) ? input.fields : [];
  const known = new Set<string>([...CONTENT_PROPOSAL_FIELDS, ...SCENE_PROPOSAL_FIELDS]);
  if (
    typeof input.proposalId !== "string" ||
    list.length === 0 ||
    !list.every((field) => typeof field === "string" && known.has(field))
  ) {
    return { status: "invalid" as const };
  }
  return copilot.accept(membership.tenantId, input.proposalId, list as ProposalField[]);
}

export async function rejectProposal(
  membership: OrganizationMembership,
  proposalId: unknown,
  copilot: CopilotRepository,
) {
  if (!canPropose(membership)) return { status: "forbidden" as const };
  if (typeof proposalId !== "string") return { status: "not_found" as const };
  return copilot.reject(membership.tenantId, proposalId);
}
