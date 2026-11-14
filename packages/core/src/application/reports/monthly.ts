import type { CopilotReviewRow, CopilotSnapshotData } from "../../contracts/copilot";
import type { OrganizationMembership } from "../../contracts/organization";
import { localClock } from "../../domain/plan/clock";
import { hasModule, type ModuleKey } from "../../domain/tenancy/modules";
import { COPILOT_ISSUE_LABELS } from "../../domain/copilot/issues";
import type { Recommendation, RecommendationFact } from "../../domain/copilot/recommendations";
import {
  formatMonth,
  isCurrentMonth,
  monthlyRecommendationPeriod,
  monthlyReportRange,
  monthOf,
  parseReportMonth,
  reportMonths,
  type ReportMonth,
} from "../../domain/reports/monthly";
import {
  summarizePassport,
  type PassportStatisticsData,
  type PassportSummary,
} from "../../domain/passport/statistics";
import {
  formatDateRange,
  summarizeStatistics,
  type DateRange,
  type StatisticsSummary,
  type VisitStatisticsData,
} from "../../domain/visits/statistics";
import type { UnansweredQuestionsData } from "../assistant/unanswered";
import { canPropose, type CopilotAiRunner } from "../copilot/copilot";
import { copilotForModules, reviewForModules } from "../copilot/modules";
import type { CopilotRepository } from "../copilot/ports";
import { runRecommendations } from "../copilot/recommendations";
import type { JobLease } from "../jobs/ports";
import { MailDeliveryError, type Mailer, type OutgoingEmail } from "../mail/invitations";
import { viewsOf, type StatisticsRepository } from "../statistics/statistics";

/**
 * The monthly report for the town hall (C1 · Paso 5, ADR-055).
 *
 * Every member reads the report of any month in the panel (/o/{slug}/informe): the same
 * numbers as «Estadísticas», «Lo que preguntan los visitantes» and the content review, for
 * one calendar month. On the 1st, a durable job (reports.monthly) asks the Copilot for the
 * month's recommendations and emails owners and admins a summary that reads without the
 * panel, with the link. Owners and admins can ask for it again (up to 3 times a day).
 */

// ── What was published ──────────────────────────────────────────────────────

export interface ContentActivityItem {
  readonly contentId: string;
  readonly kind: "destination" | "event" | "knowledge";
  readonly title: string;
  /** Its tour 360° (true) or the place itself. */
  readonly tour: boolean;
  /** Times it was published in the period. */
  readonly times: number;
  /** Published for the first time in the period. */
  readonly first: boolean;
  readonly publishedAt: string;
}

export interface ContentActivity extends DateRange {
  readonly total: number;
  readonly items: readonly ContentActivityItem[];
}

// ── The saved part: recommendations and the email ──────────────────────────

export interface SavedMonthlyReport {
  readonly generatedAt: string;
  readonly from: string;
  readonly to: string;
  readonly facts: readonly RecommendationFact[] | null;
  readonly items: readonly Recommendation[] | null;
  /** Why there are no recommendations (a refusal of the gateway or «nothing»). */
  readonly note: string | null;
  /** After 90 days the recommendations are forgotten. */
  readonly forgotten: boolean;
  readonly mailedAt: string | null;
  readonly mailedCount: number | null;
}

export interface MonthlyReportStatus extends DateRange {
  readonly today: string;
  readonly firstDay: string | null;
  readonly report: SavedMonthlyReport | null;
  /** A job for this month is waiting or running. */
  readonly pending: boolean;
  /** Emails asked for from the panel in the last 24 h (at most 3). */
  readonly requestsToday: number;
}

export type RequestMonthlyReportOutcome =
  "queued" | "forbidden" | "too_many" | "not_online" | "invalid";

/** With the signed-in user's session (the RPCs check the role again). */
export interface MonthlyReportRepository {
  status(tenantId: string, month: ReportMonth): Promise<MonthlyReportStatus>;
  questions(tenantId: string, range: DateRange): Promise<UnansweredQuestionsData>;
  activity(tenantId: string, range: DateRange): Promise<ContentActivity>;
  request(tenantId: string, month: ReportMonth): Promise<RequestMonthlyReportOutcome>;
}

export const MONTHLY_REPORT_REQUESTS_PER_DAY = 3;

const NOTHING_NOTE =
  "El Copilot no escribió recomendaciones que se apoyen en las cifras del mes: el informe va sin ellas.";

/** Why a report has no recommendations, in words. */
export const MONTHLY_NOTE_LABELS: Readonly<Record<string, string>> = {
  not_configured: "La IA no está configurada en la plataforma: el informe va sin recomendaciones.",
  tenant_quota:
    "El municipio había usado su cuota de IA del día: el informe va sin recomendaciones.",
  platform_quota:
    "La plataforma había usado su cuota de IA del día: el informe va sin recomendaciones.",
  provider_unavailable: "El servicio de IA no respondió: el informe va sin recomendaciones.",
  provider_error: "El Copilot no pudo responder: el informe va sin recomendaciones.",
  tenant_unavailable: "El municipio no estaba en línea: el informe va sin recomendaciones.",
  copilot_off: "El municipio no tiene el Copilot: el informe va sin recomendaciones.",
  visitor_limit: "El Copilot no pudo responder: el informe va sin recomendaciones.",
  nothing: NOTHING_NOTE,
};

export function monthlyNoteLabel(note: string | null): string {
  return MONTHLY_NOTE_LABELS[note ?? "nothing"] ?? NOTHING_NOTE;
}

export function canSendMonthlyReport(membership: OrganizationMembership): boolean {
  return membership.role === "owner" || membership.role === "admin";
}

// ── The page ────────────────────────────────────────────────────────────────

export interface MonthlyReportView {
  readonly month: ReportMonth;
  /** The months the panel offers, newest first. */
  readonly months: readonly ReportMonth[];
  readonly today: string;
  /** The month has not ended: its numbers run to today. */
  readonly current: boolean;
  readonly summary: StatisticsSummary;
  /** The tourist passport of the month (null: not counted yet). */
  readonly passport: PassportSummary | null;
  readonly firstDay: string | null;
  readonly questions: UnansweredQuestionsData;
  readonly review: readonly CopilotReviewRow[];
  readonly activity: ContentActivity;
  readonly snapshot: CopilotSnapshotData;
  readonly status: MonthlyReportStatus;
  /** Owners and admins: «Enviar este informe ahora por correo». */
  readonly canSend: boolean;
  /** Editors and above: «Proponer con el Copilot» in the links. */
  readonly canPropose: boolean;
}

export interface MonthlyReportDeps {
  readonly reports: MonthlyReportRepository;
  readonly statistics: StatisticsRepository;
  readonly copilot: CopilotRepository;
  readonly now?: () => Date;
}

/** The report of a month (the one that ended, by default). Any member. */
export async function loadMonthlyReport(
  membership: OrganizationMembership,
  deps: MonthlyReportDeps,
  rawMonth: unknown,
): Promise<MonthlyReportView> {
  const now = (deps.now ?? (() => new Date()))();
  const calendar = await deps.statistics.calendar(membership.tenantId);
  const today = localClock(now, calendar.timezone).date;
  const month = parseReportMonth(rawMonth, today);
  const range = monthlyReportRange(month, today);
  const days = { from: range.from, to: range.to };
  const comparable = calendar.firstDay !== null && range.previous.from >= calendar.firstDay;
  const tenant = membership.tenantId;
  const copilot = copilotForModules(deps.copilot, membership.modules);
  const withPassport = hasModule(membership.modules, "passport");
  const [current, previous, questions, activity, review, snapshot, status, passport, before] =
    await Promise.all([
      deps.statistics.statistics(tenant, days, false),
      comparable ? deps.statistics.statistics(tenant, range.previous, false) : null,
      deps.reports.questions(tenant, days),
      deps.reports.activity(tenant, days),
      copilot.review(tenant),
      copilot.snapshot(tenant),
      deps.reports.status(tenant, month),
      withPassport ? deps.statistics.passport(tenant, days, false) : null,
      withPassport ? deps.statistics.passport(tenant, range.previous, false) : null,
    ]);
  const summary = summarizeStatistics(range, current, previous, calendar.firstDay);
  return {
    month,
    months: reportMonths(today),
    today,
    current: isCurrentMonth(month, today),
    summary,
    passport: passport ? summarizePassport(range, passport, before, viewsOf(summary)) : null,
    firstDay: calendar.firstDay,
    questions,
    review,
    activity,
    snapshot,
    status,
    canSend: canSendMonthlyReport(membership),
    canPropose: canPropose(membership),
  };
}

/** «Enviar este informe ahora por correo». Owners and admins. */
export async function requestMonthlyReport(
  membership: OrganizationMembership,
  reports: MonthlyReportRepository,
  month: ReportMonth,
): Promise<RequestMonthlyReportOutcome> {
  if (!canSendMonthlyReport(membership)) return "forbidden";
  return reports.request(membership.tenantId, month);
}

// ── The job: recommendations and the email ─────────────────────────────────

export type MonthlyReportSource =
  | {
      readonly state: "run";
      readonly tenantId: string;
      readonly name: string;
      readonly slug: string;
      readonly timezone: string;
      /** YYYY-MM-01. */
      readonly month: string;
      readonly from: string;
      readonly to: string;
      readonly today: string;
      readonly firstDay: string | null;
      readonly manual: boolean;
      /** Owners and admins of the municipality, sorted. */
      readonly recipients: readonly string[];
      /** This same job already kept the recommendations (a retry). */
      readonly generated: boolean;
      readonly items: readonly Recommendation[] | null;
      readonly note: string | null;
      /** This same job already sent the email. */
      readonly mailed: boolean;
    }
  | { readonly state: "skip"; readonly reason: "not_online" | "invalid_month" };

export interface MonthlyReportData {
  readonly current: VisitStatisticsData;
  readonly previous: VisitStatisticsData | null;
  readonly questions: UnansweredQuestionsData;
  readonly review: readonly CopilotReviewRow[];
  readonly snapshot: CopilotSnapshotData;
  readonly activity: ContentActivity;
  /** The tourist passport of the month and of the one compared (null: not counted yet). */
  readonly passport: PassportStatisticsData | null;
  readonly passportPrevious: PassportStatisticsData | null;
  /** The municipality's modules (ADR-060); absent: read before that migration (all). */
  readonly modules?: readonly ModuleKey[];
}

/** worker_api, always under the job's lease and for the job's own municipality. */
export interface MonthlyReportStore {
  source(lease: JobLease): Promise<MonthlyReportSource | "lease_lost">;
  data(
    lease: JobLease,
    range: DateRange,
    previous: DateRange | null,
  ): Promise<MonthlyReportData | "lease_lost">;
  save(
    lease: JobLease,
    input: {
      readonly to: string;
      readonly aiRequestId: string | null;
      readonly facts: readonly RecommendationFact[] | null;
      readonly items: readonly Recommendation[] | null;
      readonly note: string | null;
    },
  ): Promise<"saved" | "lease_lost">;
  markMailed(
    lease: JobLease,
    count: number,
  ): Promise<"marked" | "already_mailed" | "missing" | "lease_lost">;
}

export interface ProduceMonthlyReportDeps {
  readonly store: MonthlyReportStore;
  readonly ai: CopilotAiRunner;
  /** Null when this deployment has no SMTP: the report is kept, nothing is mailed. */
  readonly mailer: Mailer | null;
  /** The panel's origin, for the link in the email. */
  readonly adminOrigin: string;
  /** Progress of the email (how many recipients already got it), kept across retries. */
  readonly sent: number;
  saveProgress(sent: number): Promise<void>;
  readonly now?: () => Date;
}

/** How many got the email, or why nobody did. */
export type MonthlyReportMailed = number | "not_configured" | "already" | "nobody";

export type ProduceMonthlyReportOutcome =
  | { readonly outcome: "skipped"; readonly reason: string }
  | {
      readonly outcome: "done";
      readonly recommendations: number;
      readonly note: string | null;
      readonly mailed: MonthlyReportMailed;
    };

/** Thrown by produceMonthlyReport; the processor turns it into a retry or a failure. */
export class MonthlyReportError extends Error {
  readonly code: "lease_lost" | "mail_refused" | "mail_unavailable";

  constructor(code: MonthlyReportError["code"], message: string) {
    super(message);
    this.name = "MonthlyReportError";
    this.code = code;
  }
}

const lost = () => new MonthlyReportError("lease_lost", "The lease was lost.");

/**
 * Runs the report of the job's month: reads the numbers, asks the Copilot once (unless this
 * same job already did), keeps the result and emails owners and admins once per job. Without
 * AI, or when the model has nothing that rests on the numbers, the report goes without
 * recommendations and says why.
 */
export async function produceMonthlyReport(
  lease: JobLease,
  deps: ProduceMonthlyReportDeps,
): Promise<ProduceMonthlyReportOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const source = await deps.store.source(lease);
  if (source === "lease_lost") throw lost();
  if (source.state === "skip") return { outcome: "skipped", reason: source.reason };

  const month = monthOf(source.month);
  const range = monthlyReportRange(month, source.today);
  const days = { from: range.from, to: range.to };
  const comparable = source.firstDay !== null && range.previous.from >= source.firstDay;
  const data = await deps.store.data(lease, days, comparable ? range.previous : null);
  if (data === "lease_lost") throw lost();
  const summary = summarizeStatistics(range, data.current, data.previous, source.firstDay);
  const modules = data.modules;
  const passport =
    data.passport && hasModule(modules, "passport")
      ? summarizePassport(range, data.passport, data.passportPrevious, viewsOf(summary))
      : null;
  const review = reviewForModules(data.review, modules);

  let items: readonly Recommendation[] | null = source.items;
  let note: string | null = source.note;
  if (!source.generated && !hasModule(modules, "copilot")) {
    // The municipality does not have the Copilot: the report goes without recommendations.
    const saved = await deps.store.save(lease, {
      to: range.to,
      aiRequestId: null,
      facts: null,
      items: null,
      note: "copilot_off",
    });
    if (saved === "lease_lost") throw lost();
    items = null;
    note = "copilot_off";
  } else if (!source.generated) {
    const run = await runRecommendations({
      tenantId: source.tenantId,
      site: source.name,
      timezone: source.timezone,
      now,
      actorId: null,
      statistics: summary,
      passport,
      period: monthlyRecommendationPeriod(month, source.today),
      questions: data.questions,
      review: data.review,
      snapshot: data.snapshot.items,
      ...(modules ? { modules } : {}),
      ai: deps.ai,
    });
    const saved =
      run.status === "answered"
        ? await deps.store.save(lease, {
            to: range.to,
            aiRequestId: run.requestId,
            facts: run.facts,
            items: run.items,
            note: null,
          })
        : await deps.store.save(lease, {
            to: range.to,
            aiRequestId: null,
            facts: null,
            items: null,
            note: run.status === "refused" ? run.outcome : "nothing",
          });
    if (saved === "lease_lost") throw lost();
    items = run.status === "answered" ? run.items : null;
    note = run.status === "answered" ? null : run.status === "refused" ? run.outcome : "nothing";
  }

  const done = (mailed: MonthlyReportMailed): ProduceMonthlyReportOutcome => ({
    outcome: "done",
    recommendations: items?.length ?? 0,
    note,
    mailed,
  });
  if (source.mailed) return done("already");
  if (deps.mailer === null) return done("not_configured");
  if (source.recipients.length === 0) return done("nobody");

  const recipients = [...source.recipients].sort();
  for (let index = deps.sent; index < recipients.length; index += 1) {
    const to = recipients[index] ?? "";
    try {
      await deps.mailer.send(
        monthlyReportEmail({
          to,
          tenantName: source.name,
          month,
          current: isCurrentMonth(month, source.today),
          summary,
          passport,
          questions: data.questions,
          review,
          activity: data.activity,
          items,
          note,
          link: monthlyReportLink(deps.adminOrigin, source.slug, month),
        }),
      );
    } catch (error) {
      if (error instanceof MailDeliveryError && error.permanent) {
        throw new MonthlyReportError("mail_refused", error.message);
      }
      throw new MonthlyReportError(
        "mail_unavailable",
        error instanceof Error ? error.message : "The mail server did not answer.",
      );
    }
    await deps.saveProgress(index + 1);
  }
  const marked = await deps.store.markMailed(lease, recipients.length);
  if (marked === "lease_lost") throw lost();
  return done(recipients.length);
}

// ── The email ───────────────────────────────────────────────────────────────

export function monthlyReportPath(slug: string, month: ReportMonth): string {
  return `/o/${slug}/informe?mes=${month}`;
}

export function monthlyReportLink(adminOrigin: string, slug: string, month: ReportMonth): string {
  return `${adminOrigin.replace(/\/+$/u, "")}${monthlyReportPath(slug, month)}`;
}

const COUNT = new Intl.NumberFormat("es-BO");

function n(value: number): string {
  return COUNT.format(value);
}

function plural(value: number, one: string, many: string): string {
  return `${n(value)} ${value === 1 ? one : many}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** One plain line (names and visitor questions are data). */
function plain(value: string, max = 160): string {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** «▲ 12 %; el mes anterior: 25», or nothing when it cannot be compared. */
export function changeLine(value: number, previous: number | null, before: string): string {
  if (previous === null) return "";
  if (previous === 0) return `${before}: 0`;
  const percent = Math.round(((value - previous) / previous) * 100);
  if (percent === 0) return `igual que ${before}`;
  return `${percent > 0 ? "▲" : "▼"} ${n(Math.abs(percent))} %; ${before}: ${n(previous)}`;
}

export interface MonthlyEmailInput {
  readonly to: string;
  readonly tenantName: string;
  readonly month: ReportMonth;
  /** The month has not ended (sent from the panel before the 1st). */
  readonly current: boolean;
  readonly summary: StatisticsSummary;
  /** The tourist passport of the month (null or inactive: no section). */
  readonly passport?: PassportSummary | null;
  readonly questions: UnansweredQuestionsData;
  readonly review: readonly CopilotReviewRow[];
  readonly activity: ContentActivity;
  readonly items: readonly Recommendation[] | null;
  readonly note: string | null;
  readonly link: string;
}

interface EmailSection {
  readonly title: string;
  readonly lines: readonly string[];
}

/** The sections of the email, in words: the same for its text and its HTML. */
export function monthlyEmailSections(input: MonthlyEmailInput): EmailSection[] {
  const { summary } = input;
  const before = input.current ? "los mismos días del mes anterior" : "el mes anterior";
  const t = summary.totals;
  const compare = (value: number, previous: number | null) => {
    const words = summary.compared ? changeLine(value, previous, before) : "";
    return words ? ` (${words})` : "";
  };
  const visits: string[] = summary.empty
    ? ["El portal no registró visitas en el período."]
    : [
        `${plural(t.views.value, "vista", "vistas")} de páginas${compare(t.views.value, t.views.previous)}.`,
        `${plural(t.visitors.value, "visitante", "visitantes")} (personas distintas por día, sumadas)${compare(t.visitors.value, t.visitors.previous)}.`,
        `${plural(t.qr.value, "escaneo", "escaneos")} de códigos QR, ${n(t.directions.value)} «Cómo llegar», ${n(t.share.value)} «Compartir» y ${plural(t.scenes.value, "escena vista", "escenas vistas")} en los tours 360°.`,
      ];
  if (!summary.compared && !summary.empty) {
    visits.push(
      `Sin comparación: el portal empezó a contar visitas después del inicio de ${before}.`,
    );
  }

  const top = summary.places.filter((place) => place.views > 0).slice(0, 5);
  const places = top.map(
    (place, index) =>
      `${index + 1}. ${plain(place.title, 80)}: ${plural(place.views, "vista", "vistas")}${place.qr > 0 ? `, ${plural(place.qr, "escaneo de QR", "escaneos de QR")}` : ""}.`,
  );
  const tour = summary.tours.find((item) => item.views + item.sceneViews > 0);
  if (tour) {
    places.push(
      `Tour 360° más visto: ${plain(tour.title, 80)} (${plural(tour.views, "vista", "vistas")}, ${plural(tour.sceneViews, "escena vista", "escenas vistas")}).`,
    );
  }

  const passport = input.passport?.active ? input.passport : null;
  const passportLines: string[] = [];
  if (passport) {
    const p = passport.totals;
    const comparePassport = (value: number, previous: number | null) => {
      const words = passport.compared ? changeLine(value, previous, before) : "";
      return words ? ` (${words})` : "";
    };
    passportLines.push(
      `${plural(p.stamps.value, "sello", "sellos")} en los lugares${comparePassport(p.stamps.value, p.stamps.previous)}, ${n(p.located.value)} con la ubicación del teléfono en el lugar (visitas comprobadas en el lugar).`,
      `${plural(p.completed.value, "circuito completado", "circuitos completados")} y ${plural(p.redeemed.value, "premio canjeado", "premios canjeados")}.`,
    );
    const stamped = passport.places.filter((place) => place.stamps > 0).slice(0, 5);
    passportLines.push(
      ...stamped.map(
        (place, index) =>
          `${index + 1}. ${plain(place.title, 80)}: ${plural(place.stamps, "sello", "sellos")} (${n(place.located)} con ubicación).`,
      ),
    );
    const unstamped = passport.places.filter((place) => place.stop && place.stamps === 0);
    if (unstamped.length > 0) {
      passportLines.push(
        `Sin sellos en el período: ${unstamped
          .slice(0, 5)
          .map((place) => plain(place.title, 60))
          .join(", ")}.`,
      );
    }
  }

  const q = input.questions;
  const questions =
    q.total === 0
      ? ["El asistente respondió todas las preguntas que le hicieron."]
      : [
          `El asistente no supo responder ${plural(q.total, "pregunta", "preguntas")} de ${plural(q.people, "persona", "personas")}. Las más frecuentes:`,
          ...q.groups
            .slice(0, 5)
            .map((group) => `«${plain(group.text, 120)}» (${plural(group.times, "vez", "veces")})`),
        ];

  const published = input.activity.items.filter((item) => !item.tour);
  const content = [
    input.activity.total === 0
      ? "No se publicó nada en el período."
      : `Se publicaron ${plural(published.filter((item) => item.first).length, "contenido nuevo", "contenidos nuevos")} y ${plural(input.activity.total, "actualización", "actualizaciones")} en total (incluidos los tours 360°).`,
    input.review.length === 0
      ? "A los destinos y eventos no les falta nada de lo que revisa el Copilot."
      : `${plural(new Set(input.review.map((row) => row.contentId)).size, "destino o evento tiene", "destinos o eventos tienen")} algo por completar, por ejemplo: ${input.review
          .slice(0, 3)
          .map(
            (row) =>
              `${plain(row.title, 60)} (${row.sceneTitle ? "una escena sin descripción" : (row.issues[0] ? COPILOT_ISSUE_LABELS[row.issues[0]] : "revisar").toLowerCase()})`,
          )
          .join("; ")}.`,
  ];

  const recommendations =
    input.items && input.items.length > 0
      ? input.items.map(
          (item, index) => `${index + 1}. ${plain(item.title)}. ${plain(item.why, 500)}`,
        )
      : [monthlyNoteLabel(input.note)];

  return [
    { title: "Visitas", lines: visits },
    ...(places.length > 0 ? [{ title: "Lo más visto", lines: places }] : []),
    ...(passportLines.length > 0 ? [{ title: "Pasaporte turístico", lines: passportLines }] : []),
    { title: "Preguntas sin respuesta", lines: questions },
    { title: "Estado del contenido", lines: content },
    { title: "Recomendaciones del Copilot", lines: recommendations },
  ];
}

/**
 * The email for owners and admins: a summary that reads without the panel and the link to
 * the full report. Plain text and simple HTML; no images, no tracking, no secrets.
 */
export function monthlyReportEmail(input: MonthlyEmailInput): OutgoingEmail {
  const tenant = plain(input.tenantName, 120);
  const period = formatDateRange(input.summary.range);
  const subject = input.current
    ? `Informe de ${formatMonth(input.month)} (hasta hoy) · ${tenant}`
    : `Informe de ${formatMonth(input.month)} · ${tenant}`;
  const intro = `Este es el informe del portal de ${tenant}, ${period}.`;
  const sections = monthlyEmailSections(input);
  const closing = [
    "Las cifras son un mínimo: no cuentan a quien bloquea JavaScript ni los escaneos de códigos QR descargados antes de que el panel empezara a contarlos. Las recomendaciones del Copilot se basan solo en estas cifras; nada se publica solo.",
    "Recibes este correo como propietario o administrador del portal.",
  ];
  const text = [
    "Hola:",
    "",
    intro,
    "",
    ...sections.flatMap((section) => [section.title.toUpperCase(), ...section.lines, ""]),
    `Informe completo (para imprimir o guardar como PDF): ${input.link}`,
    "",
    ...closing,
    "",
    "Rikuy",
  ].join("\n");
  const link = escapeHtml(input.link);
  const html = [
    '<!doctype html><html lang="es"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2328;max-width:640px">',
    "<p>Hola:</p>",
    `<p>${escapeHtml(intro)}</p>`,
    ...sections.map(
      (section) =>
        `<h2 style="font-size:1.05rem;margin:1.4em 0 .4em">${escapeHtml(section.title)}</h2>` +
        section.lines.map((item) => `<p style="margin:.3em 0">${escapeHtml(item)}</p>`).join(""),
    ),
    `<p style="margin-top:1.6em"><a href="${link}">Abrir el informe completo</a> (para imprimir o guardar como PDF).</p>`,
    ...closing.map((item) => `<p style="color:#59636e;font-size:.9rem">${escapeHtml(item)}</p>`),
    "<p>Rikuy</p>",
    "</body></html>",
  ].join("");
  return { to: input.to, subject, text, html };
}
