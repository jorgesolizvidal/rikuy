import { measure, type Measure, type StatisticsRange } from "../visits/statistics";

/**
 * The visitor's assistant by channel (A · Paso 5.1, ADR-074): what the database counts and what
 * «Estadísticas», the monthly report and the Copilot's recommendations show.
 */

export const ASSISTANT_CHANNEL_KEYS = ["portal", "embed", "qr", "whatsapp"] as const;
export type AssistantChannelKey = (typeof ASSISTANT_CHANNEL_KEYS)[number];

export const ASSISTANT_CHANNEL_NAMES: Readonly<Record<AssistantChannelKey, string>> = {
  portal: "En el portal",
  embed: "En la web del municipio",
  qr: "Desde un QR «Pregúntale a…»",
  whatsapp: "Por WhatsApp",
};

export const ASSISTANT_ACTION_KEYS = ["place", "tour", "map", "section", "person"] as const;
export type AssistantActionKey = (typeof ASSISTANT_ACTION_KEYS)[number];

export const ASSISTANT_ACTION_NAMES: Readonly<Record<AssistantActionKey, string>> = {
  place: "Abrieron una ficha",
  tour: "Abrieron un tour 360°",
  map: "Abrieron el mapa",
  section: "Abrieron una sección del portal",
  person: "Escribieron o llamaron al municipio",
};

/** The kinds of content an answer can cite (ADR-069). */
export type CitedKind = "destination" | "event" | "knowledge" | "notice" | "service" | "story";

export const CITED_KIND_NAMES: Readonly<Record<CitedKind, string>> = {
  destination: "Destino",
  event: "Evento",
  knowledge: "Conocimiento",
  notice: "Aviso",
  service: "Servicio",
  story: "Relato",
};

export interface AssistantChannelRow {
  readonly channel: AssistantChannelKey;
  readonly conversations: number;
  /** Distinct per day, summed (like the visitors, ADR-051). */
  readonly people: number;
  readonly answered: number;
  readonly abstained: number;
  readonly plans: number;
  /** Out of quota or with the provider down. */
  readonly notices: number;
  /** Ended in «Hablar con una persona» (ADR-073). */
  readonly askedPerson: number;
  /** Answers after which the visitor tapped something in them. */
  readonly withAction: number;
}

export interface AssistantTopicRow {
  readonly contentId: string;
  readonly kind: CitedKind;
  readonly slug: string;
  readonly title: string;
  readonly published: boolean;
  /** Answers that cited it. */
  readonly times: number;
  readonly channels: Readonly<Record<AssistantChannelKey, number>>;
}

export interface AssistantActionRow {
  readonly action: AssistantActionKey;
  readonly times: number;
  /** Distinct answers. */
  readonly answers: number;
}

export interface AssistantStatisticsData {
  readonly from: string;
  readonly to: string;
  /** The first counted day (null: nothing counted yet). */
  readonly since: string | null;
  readonly channels: readonly AssistantChannelRow[];
  readonly topics: readonly AssistantTopicRow[];
  readonly actions: readonly AssistantActionRow[];
}

export const ASSISTANT_TOTALS = [
  "conversations",
  "people",
  "abstained",
  "askedPerson",
  "withAction",
] as const;
export type AssistantTotal = (typeof ASSISTANT_TOTALS)[number];

export interface AssistantChannelSummary extends AssistantChannelRow {
  readonly name: string;
  /** Share of the period's conversations, 0–100. */
  readonly share: number;
}

export interface AssistantSummary {
  /** False when the previous period starts before the first counted conversation. */
  readonly compared: boolean;
  readonly since: string | null;
  readonly totals: Readonly<Record<AssistantTotal, Measure>>;
  /** Every channel with a conversation, the most used first. */
  readonly channels: readonly AssistantChannelSummary[];
  readonly topics: readonly (AssistantTopicRow & { readonly kindName: string })[];
  readonly actions: readonly (AssistantActionRow & { readonly name: string })[];
  /** Nothing was asked in the period. */
  readonly empty: boolean;
}

function totalsOf(data: AssistantStatisticsData): Record<AssistantTotal, number> {
  const sum = (key: AssistantTotal) => data.channels.reduce((total, row) => total + row[key], 0);
  return Object.fromEntries(ASSISTANT_TOTALS.map((key) => [key, sum(key)])) as Record<
    AssistantTotal,
    number
  >;
}

/** The period's numbers and, when the previous period was counted entirely, how they changed. */
export function summarizeAssistant(
  range: StatisticsRange,
  current: AssistantStatisticsData,
  previous: AssistantStatisticsData | null,
): AssistantSummary {
  const compared =
    previous !== null && current.since !== null && range.previous.from >= current.since;
  const now = totalsOf(current);
  const before = compared && previous ? totalsOf(previous) : null;
  const totals = Object.fromEntries(
    ASSISTANT_TOTALS.map((key) => [key, measure(now[key], before ? before[key] : null)]),
  ) as Record<AssistantTotal, Measure>;
  return {
    compared,
    since: current.since,
    totals,
    channels: current.channels
      .filter((row) => row.conversations > 0)
      .toSorted((a, b) => b.conversations - a.conversations)
      .map((row) => ({
        ...row,
        name: ASSISTANT_CHANNEL_NAMES[row.channel],
        share:
          now.conversations === 0 ? 0 : Math.round((row.conversations / now.conversations) * 100),
      })),
    topics: current.topics.map((row) => ({ ...row, kindName: CITED_KIND_NAMES[row.kind] })),
    actions: current.actions
      .toSorted((a, b) => b.times - a.times)
      .map((row) => ({ ...row, name: ASSISTANT_ACTION_NAMES[row.action] })),
    empty: now.conversations === 0,
  };
}
