import {
  invitationEmail,
  JOB_KINDS,
  MailDeliveryError,
  membershipInvitationMailPayloadSchema,
  permanentFailure,
  transientFailure,
  type InvitationMailStore,
  type JobProcessor,
  type Mailer,
} from "@rikuy/core";

export interface MembershipInvitationMailDeps {
  readonly invitations: InvitationMailStore;
  /** Null when this deployment has no SMTP: the job ends without sending anything. */
  readonly mailer: Mailer | null;
  /** Where the invited person signs in (the panel's origin). */
  readonly adminOrigin: string;
}

/**
 * mail.membership_invitation: emails a pending invitation once (ADR-034).
 *
 * At least once: if the runner dies between sending and recording, the retry sends it
 * again. Everything else is idempotent: an accepted, revoked or replaced invitation, or one
 * already recorded as sent, sends nothing.
 */
export function createMembershipInvitationMailProcessor(
  deps: MembershipInvitationMailDeps,
): JobProcessor {
  return {
    kind: JOB_KINDS.membershipInvitationMail,
    schemaVersions: [1],
    async run({ job }) {
      if (!membershipInvitationMailPayloadSchema.safeParse(job.payload).success) {
        throw permanentFailure("invalid_payload", "The job payload is not valid.");
      }
      const lease = { jobId: job.jobId, fencingToken: job.fencingToken };
      const lost = () => transientFailure("lease_lost", "The lease was lost.");

      if (deps.mailer === null) return { result: { outcome: "mail_not_configured" } };

      const found = await deps.invitations.inspect(lease);
      if (found === "lease_lost") throw lost();
      if (found.state !== "send") return { result: { outcome: found.state } };

      try {
        await deps.mailer.send(
          invitationEmail({
            to: found.email,
            tenantName: found.tenantName,
            role: found.role,
            adminOrigin: deps.adminOrigin,
          }),
        );
      } catch (error) {
        if (error instanceof MailDeliveryError && error.permanent) {
          throw permanentFailure("mail_refused", error.message);
        }
        throw transientFailure(
          "mail_unavailable",
          error instanceof Error ? error.message : "The mail server did not answer.",
        );
      }

      const marked = await deps.invitations.markMailed(lease);
      if (marked === "lease_lost") throw lost();
      return { result: { outcome: "sent" } };
    },
  };
}
