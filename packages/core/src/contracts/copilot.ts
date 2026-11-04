import type { EventSchedule } from "./event";
import type { RichText } from "./rich-text";

/**
 * The staff's Copilot (P5 · Paso 7, ADR-042, ADR-008):
 *
 * - V1 reads and analyzes: the content review (fixed rules, computed by the database) and
 *   questions answered from an authorized snapshot of the municipality's content;
 * - V2 proposes: the texts of one destination, event or tour scene, as a proposal with a
 *   diff on a base revision, that an editor accepts field by field into a DRAFT.
 *
 * Never publishes, never sends anything, never changes roles.
 */

/** What the review finds, by fixed rules (copilot_content_review). */
export const COPILOT_ISSUES = [
  "never_published",
  "unpublished_changes",
  "summary_missing",
  "summary_short",
  "body_missing",
  "body_short",
  "cover_missing",
  "location_missing",
  "hours_missing",
  "schedule_missing",
  "tour_missing",
  "scene_description_missing",
] as const;
export type CopilotIssue = (typeof COPILOT_ISSUES)[number];

export type CopilotContentKind = "destination" | "event";

/** One row of the review: an item (or a scene of its tour) and what it lacks. */
export interface CopilotReviewRow {
  readonly kind: CopilotContentKind;
  readonly contentId: string;
  readonly slug: string;
  /** Set for a scene of the item's tour. */
  readonly tourId: string | null;
  readonly sceneId: string | null;
  readonly title: string;
  readonly sceneTitle: string | null;
  readonly status: "draft" | "published" | "changed";
  readonly issues: readonly CopilotIssue[];
}

/** One item of the snapshot the model reads (copilot_snapshot): drafts included. */
export interface CopilotSnapshotRow {
  readonly kind: CopilotContentKind;
  readonly contentId: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly status: "draft" | "published" | "changed";
  readonly schedule: EventSchedule | null;
  readonly ended: boolean;
  readonly tour: {
    readonly tourId: string;
    readonly status: "draft" | "published" | "changed";
    readonly scenes: number;
  } | null;
}

export interface CopilotSnapshotData {
  readonly timezone: string;
  readonly items: readonly CopilotSnapshotRow[];
}

export type ProposalTarget =
  | { readonly type: "content"; readonly contentId: string }
  | { readonly type: "scene"; readonly tourId: string; readonly sceneId: string };

export const CONTENT_PROPOSAL_FIELDS = ["title", "summary", "body"] as const;
export const SCENE_PROPOSAL_FIELDS = ["title", "description"] as const;
export type ProposalField = "title" | "summary" | "body" | "description";

/** The values a proposal changes: plain text, or rich text for the body. */
export type ProposalValue = string | RichText;

export interface ProposalChange {
  readonly from: ProposalValue;
  readonly to: ProposalValue;
}

export type ProposalChanges = Readonly<Partial<Record<ProposalField, ProposalChange>>>;

export interface ProposalSource {
  /** «Destino», «Evento», «Tour 360°», «Documento». */
  readonly label: string;
  readonly title: string;
}

export type ProposalStatus = "pending" | "accepted" | "rejected" | "expired";

export interface ProposalListEntry {
  readonly id: string;
  readonly target: ProposalTarget;
  readonly contentKind: CopilotContentKind;
  readonly contentId: string;
  /** The item's title now (its working revision). */
  readonly title: string;
  readonly sceneTitle: string | null;
  readonly fields: readonly ProposalField[];
  readonly instruction: string;
  readonly status: ProposalStatus;
  /** Pending, but its base is not what an editor would edit now: it can only be rejected. */
  readonly stale: boolean;
  readonly acceptedFields: readonly ProposalField[] | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly mine: boolean;
}

export interface ProposalView extends Omit<ProposalListEntry, "fields" | "mine"> {
  readonly changes: ProposalChanges;
  readonly sources: readonly ProposalSource[];
}

/** One turn of the (never stored) conversation with the Copilot. */
export interface CopilotTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** Where an answer's source leads in the panel. */
export interface CopilotSourceLink {
  readonly label: string;
  readonly title: string;
  /** A path of the panel (an editor), or null (a document, the plan's usage). */
  readonly href: string | null;
}

export type CopilotAnswerBlock =
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "list"; readonly items: readonly string[] };

export type CopilotAnswer =
  | {
      readonly status: "answered";
      readonly blocks: readonly CopilotAnswerBlock[];
      readonly sources: readonly CopilotSourceLink[];
    }
  | { readonly status: "notice"; readonly message: string }
  | { readonly status: "invalid" };

/** The ready-made requests for a proposal (the staff may add their own words). */
export const PROPOSAL_STYLES = ["improve", "shorter", "longer", "formal", "warm"] as const;
export type ProposalStyle = (typeof PROPOSAL_STYLES)[number];

export const PROPOSAL_STYLE_LABELS: Readonly<Record<ProposalStyle, string>> = {
  improve: "Mejorar la redacción",
  shorter: "Más corto",
  longer: "Más completo",
  formal: "Tono más formal",
  warm: "Tono más cercano",
};

export const COPILOT_LIMITS = {
  /** The staff's question or added words. */
  question: 500,
  instruction: 300,
  /** Previous turns sent with a question (each cut to `turn` characters). */
  history: 6,
  turn: 600,
  /** Items of the snapshot the model reads (the review always goes whole). */
  snapshotItems: 60,
  /** Published passages given with a question or a proposal. */
  passages: 4,
  /** Days a proposal waits to be decided. */
  proposalDays: 30,
} as const;
