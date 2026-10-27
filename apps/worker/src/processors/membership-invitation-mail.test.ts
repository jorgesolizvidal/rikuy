import {
  drainJobs,
  invitationEmail,
  MailDeliveryError,
  type InvitationMailState,
  type InvitationMailStore,
  type OutgoingEmail,
} from "@rikuy/core";
import { createMemoryJobLedger } from "@rikuy/core/testing";
import { describe, expect, it } from "vitest";

import { createMembershipInvitationMailProcessor } from "./membership-invitation-mail";

const MEMBERSHIP = "5eed3000-0000-4000-8000-0000000000c1";
const ORIGIN = "https://panel.example.test";

function fakes(options: { state?: InvitationMailState; failures?: Error[] } = {}) {
  const sent: OutgoingEmail[] = [];
  const failures = [...(options.failures ?? [])];
  let mailed = false;
  const invitations: InvitationMailStore = {
    async inspect() {
      if (mailed) return { state: "already_sent" };
      return (
        options.state ?? {
          state: "send",
          email: "nueva@example.test",
          tenantName: "Demo Valle",
          role: "editor",
          tenantStatus: "active",
        }
      );
    },
    async markMailed() {
      if (mailed) return "already_settled";
      mailed = true;
      return "marked";
    },
  };
  const mailer = {
    async send(email: OutgoingEmail) {
      const failure = failures.shift();
      if (failure) throw failure;
      sent.push(email);
    },
  };
  return { invitations, mailer, sent, mailed: () => mailed };
}

async function run(
  deps: ReturnType<typeof fakes>,
  options: { mailer?: null; payload?: unknown } = {},
) {
  const ledger = createMemoryJobLedger();
  ledger.add({
    jobId: "j",
    kind: "mail.membership_invitation",
    payload: options.payload ?? { membershipId: MEMBERSHIP },
    maxAttempts: 5,
  });
  const processor = createMembershipInvitationMailProcessor({
    invitations: deps.invitations,
    mailer: options.mailer === null ? null : deps.mailer,
    adminOrigin: ORIGIN,
  });
  await drainJobs({ ledger, processors: [processor], runnerId: "test", budgetMs: 2_000 });
  return ledger.jobs.get("j");
}

describe("mail.membership_invitation", () => {
  it("sends the invitation once and records it", async () => {
    const deps = fakes();
    const job = await run(deps);
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toEqual({ outcome: "sent" });
    expect(deps.mailed()).toBe(true);
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0]?.to).toBe("nueva@example.test");
    expect(deps.sent[0]?.subject).toBe("Invitación al panel de Demo Valle");
    expect(deps.sent[0]?.text).toContain(`Entra a ${ORIGIN} con este correo`);
  });

  it("does nothing without SMTP: invitations keep working through the panel", async () => {
    const deps = fakes();
    const job = await run(deps, { mailer: null });
    expect(job?.status).toBe("succeeded");
    expect(job?.result).toEqual({ outcome: "mail_not_configured" });
    expect(deps.sent).toHaveLength(0);
  });

  it("sends nothing for an invitation that is no longer pending", async () => {
    const deps = fakes({ state: { state: "not_pending" } });
    expect((await run(deps))?.result).toEqual({ outcome: "not_pending" });
    expect(deps.sent).toHaveLength(0);
  });

  it("retries when the server does not answer, and stops when it refuses the address", async () => {
    const flaky = fakes({ failures: [new Error("connect ETIMEDOUT smtp.example.test:465")] });
    const retried = await run(flaky);
    // The first attempt failed as transient; the retry sent it.
    expect(retried?.attempts).toBe(2);
    expect(retried?.status).toBe("succeeded");
    expect(flaky.sent).toHaveLength(1);

    const refused = fakes({ failures: [new MailDeliveryError("550 mailbox unavailable", true)] });
    const dead = await run(refused);
    expect(dead?.status).toBe("dead_letter");
    expect(dead?.lastError?.code).toBe("mail_refused");
  });

  it("refuses a payload that is not just the membership", async () => {
    const deps = fakes();
    const job = await run(deps, { payload: { membershipId: MEMBERSHIP, email: "x@example.test" } });
    expect(job?.status).toBe("dead_letter");
    expect(deps.sent).toHaveLength(0);
  });
});

describe("invitation email", () => {
  it("names the municipality and the role, with no secret and no HTML from the data", () => {
    const email = invitationEmail({
      to: "ana@example.test",
      tenantName: "Valle <b>Alto</b>\nBcc: x@example.test",
      role: "owner",
      adminOrigin: ORIGIN,
    });
    expect(email.subject).toBe("Invitación al panel de Valle <b>Alto</b> Bcc: x@example.test");
    expect(email.subject).not.toContain("\n");
    expect(email.html).toContain("Valle &lt;b&gt;Alto&lt;/b&gt;");
    expect(email.html).not.toContain("<b>Alto</b>");
    expect(email.text).toContain("como propietario");
    expect(email.text).toContain("No necesitas contraseña");
    expect(email.html).toContain(`<a href="${ORIGIN}">`);
  });
});
