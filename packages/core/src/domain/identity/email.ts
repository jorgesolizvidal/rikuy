/** Email and one-time-code validation for sign-in. Pure, no I/O. */

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/u;
const CODE_PATTERN = /^\d{6}$/;

/** Lowercased, trimmed email, or null when it is not a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

/** Six-digit one-time code with spaces removed, or null. */
export function normalizeOneTimeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.replace(/\s+/g, "");
  return CODE_PATTERN.test(code) ? code : null;
}
