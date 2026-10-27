import { MailDeliveryError, type Mailer, type OutgoingEmail } from "@rikuy/core";
import { createTransport } from "nodemailer";

/**
 * SMTP adapter for the job runner's emails (ADR-034). Any SMTP account works: a dedicated
 * Gmail account with an app password while there is no own domain, a provider with a
 * verified domain later. Imported only from "@rikuy/db/worker".
 */

export interface SmtpMailerOptions {
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  readonly password?: string;
  /** "Name <address>": must be the account itself (or an address it may send as). */
  readonly from: string;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** True when the server refused this email for good (5xx), so retrying will not help. */
export function isPermanentSmtpError(error: unknown): boolean {
  const value = error as { responseCode?: unknown; code?: unknown } | null;
  if (typeof value?.responseCode === "number") return value.responseCode >= 500;
  return value?.code === "EAUTH" || value?.code === "EENVELOPE";
}

export function createSmtpMailer(options: SmtpMailerOptions): Mailer {
  const local = LOCAL_HOSTS.has(options.host);
  const transport = createTransport({
    host: options.host,
    port: options.port,
    // 465: TLS from the start. 587: STARTTLS, required. Only a local test server (Mailpit)
    // may go without it.
    secure: options.port === 465,
    requireTLS: !local && options.port !== 465,
    ...(options.user ? { auth: { user: options.user, pass: options.password ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return {
    async send(email: OutgoingEmail) {
      try {
        await transport.sendMail({
          from: options.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          html: email.html,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "The SMTP server failed.";
        // Never echo credentials, even if a server quotes them back.
        const safe = options.password ? message.replaceAll(options.password, "***") : message;
        throw new MailDeliveryError(safe.slice(0, 300), isPermanentSmtpError(error));
      }
    },
  };
}
