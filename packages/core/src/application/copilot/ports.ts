import type {
  CopilotReviewRow,
  CopilotSnapshotData,
  ProposalField,
  ProposalListEntry,
  ProposalSource,
  ProposalTarget,
  ProposalView,
} from "../../contracts/copilot";
import type { RichText } from "../../contracts/rich-text";

export type CreateProposalOutcome =
  | { readonly status: "created"; readonly proposalId: string }
  | {
      readonly status: "stale" | "unchanged" | "invalid" | "forbidden" | "not_found";
    };

export type AcceptProposalOutcome =
  | { readonly status: "accepted"; readonly revisionNo: number; readonly editCount: number }
  | {
      readonly status: "stale" | "expired" | "decided" | "invalid" | "forbidden" | "not_found";
    };

export type RejectProposalOutcome =
  { readonly status: "rejected" } | { readonly status: "decided" | "forbidden" | "not_found" };

/** The Copilot's data with the signed-in user's session (the RPCs re-check the role). */
export interface CopilotRepository {
  review(tenantId: string): Promise<CopilotReviewRow[]>;
  snapshot(tenantId: string): Promise<CopilotSnapshotData>;
  createProposal(input: {
    readonly tenantId: string;
    readonly target: ProposalTarget;
    readonly baseRevisionId: string;
    /** The open draft's edit number, or null when the base is the published revision. */
    readonly baseEdit: number | null;
    readonly changes: Readonly<Partial<Record<ProposalField, string | RichText>>>;
    readonly sources: readonly ProposalSource[];
    readonly instruction: string;
    readonly aiRequestId: string;
  }): Promise<CreateProposalOutcome>;
  listProposals(tenantId: string): Promise<ProposalListEntry[]>;
  proposal(tenantId: string, proposalId: string): Promise<ProposalView | null>;
  accept(
    tenantId: string,
    proposalId: string,
    fields: readonly ProposalField[],
  ): Promise<AcceptProposalOutcome>;
  reject(tenantId: string, proposalId: string): Promise<RejectProposalOutcome>;
}
