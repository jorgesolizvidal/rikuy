import type { MembershipRole } from "../../contracts/organization";
import { ROLE_LABELS } from "../../contracts/organization";
import type { JobLease } from "../jobs/ports";

/**
 * Invitation emails (ADR-034). Inviting someone enqueues mail.membership_invitation in the
 * same transaction; the runner reads the invitation under the job's lease, sends one email
 * and records it. The email has no secret in it: the person signs in to the panel with
 * their address, as always, and finds the invitation there.
 */

export type InvitationMailState =
  | {
      readonly state: "send";
      readonly email: string;
      readonly tenantName: string;
      readonly role: MembershipRole;
      readonly tenantStatus: "provisioning" | "active";
    }
  | { readonly state: "already_sent" | "not_pending" };

/** The ledger's view of the invitation of a mail job (worker_api), always under its lease. */
export interface InvitationMailStore {
  inspect(lease: JobLease): Promise<InvitationMailState | "lease_lost">;
  markMailed(lease: JobLease): Promise<"marked" | "already_settled" | "lease_lost">;
}

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** An email the provider did not take. `permanent`: the same email will never go through. */
export class MailDeliveryError extends Error {
  readonly permanent: boolean;

  constructor(message: string, permanent: boolean) {
    super(message);
    this.name = "MailDeliveryError";
    this.permanent = permanent;
  }
}

/** An SMTP account (or any provider); throws MailDeliveryError when it refuses. */
export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

const ROLE_DUTIES: Readonly<Record<MembershipRole, string>> = {
  owner: "Como propietario, administras todo el portal: su marca, su contenido y sus miembros.",
  admin: "Como administrador, publicas el contenido y gestionas a editores y analistas.",
  editor: "Como editor, preparas destinos, eventos y tours para que se publiquen.",
  analyst: "Como analista, ves el contenido y el uso del portal, sin cambiarlo.",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Removes what could turn a name into a header or a link in a mail client. */
function plainName(value: string): string {
  return value
    .replace(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, 120);
}

/** The invitation email, in plain text and in simple HTML (no images, no tracking). */
export function invitationEmail(input: {
  readonly to: string;
  readonly tenantName: string;
  readonly role: MembershipRole;
  readonly adminOrigin: string;
}): OutgoingEmail {
  const tenant = plainName(input.tenantName);
  const role = ROLE_LABELS[input.role].toLowerCase();
  const subject = `Invitación al panel de ${tenant}`;
  const steps = [
    `Entra a ${input.adminOrigin} con este correo (${input.to}).`,
    "Te enviaremos un código de acceso de 6 dígitos.",
    "En el inicio verás la invitación: pulsa «Aceptar».",
  ];
  const text = [
    "Hola:",
    "",
    `Te invitaron a ${tenant} como ${role}. ${ROLE_DUTIES[input.role]}`,
    "",
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
    "No necesitas contraseña. Si no esperabas esta invitación, ignora este correo: sin aceptarla, no tienes acceso a nada.",
    "",
    "Rikuy",
  ].join("\n");
  const link = escapeHtml(input.adminOrigin);
  const html = [
    '<!doctype html><html lang="es"><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1f2328">',
    "<p>Hola:</p>",
    `<p>Te invitaron a <strong>${escapeHtml(tenant)}</strong> como ${escapeHtml(role)}. ${escapeHtml(ROLE_DUTIES[input.role])}</p>`,
    "<ol>",
    `<li>Entra a <a href="${link}">${link}</a> con este correo (${escapeHtml(input.to)}).</li>`,
    ...steps.slice(1).map((step) => `<li>${escapeHtml(step)}</li>`),
    "</ol>",
    "<p>No necesitas contraseña. Si no esperabas esta invitación, ignora este correo: sin aceptarla, no tienes acceso a nada.</p>",
    "<p>Rikuy</p>",
    "</body></html>",
  ].join("");
  return { to: input.to, subject, text, html };
}
