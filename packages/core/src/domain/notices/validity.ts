import { localTimeValue } from "../../contracts/event";
import {
  NOTICE_LIMITS,
  type NoticeDocument,
  type NoticeIssue,
  type NoticeValidity,
} from "../../contracts/notice";
import { localClock } from "../plan/clock";

/**
 * A notice's validity against the municipality's clock (ADR-069). Local values are compared on
 * a UTC timeline, like events: «hasta 18:00» is 18:00 in the municipality. The database checks
 * the same rules with its own clock when publishing and when reading.
 */

const DAY_MS = 86_400_000;

/** Now, as a local minute of the municipality: `YYYY-MM-DDTHH:MM`. */
export function localMinuteNow(now: Date, timezone: string): string {
  const clock = localClock(now, timezone);
  const hours = String(Math.floor(clock.minutes / 60)).padStart(2, "0");
  const minutes = String(clock.minutes % 60).padStart(2, "0");
  return `${clock.date}T${hours}:${minutes}`;
}

/**
 * Where a published notice stands now: `scheduled` (its «desde» did not come), `active`,
 * `expired` (its «hasta» came) or `incomplete` (no «hasta»: never published that way).
 */
export type NoticeState = "scheduled" | "active" | "expired" | "incomplete";

export function noticeState(validity: NoticeValidity, now: Date, timezone: string): NoticeState {
  const until = validity.until === null ? null : localTimeValue(validity.until, false);
  if (until === null) return "incomplete";
  const at = localTimeValue(localMinuteNow(now, timezone), false) ?? now.getTime();
  if (at >= until) return "expired";
  const from = validity.from === null ? null : localTimeValue(validity.from, false);
  if (from !== null && at < from) return "scheduled";
  return "active";
}

/** What a draft still needs, now, to be published (the database asks the same). */
export function noticePublicationIssues(
  document: NoticeDocument,
  now: Date,
  timezone: string,
): NoticeIssue[] {
  const issues: NoticeIssue[] = [];
  if (document.summary === "") issues.push({ path: "summary", code: "required" });
  const until =
    document.validity.until === null ? null : localTimeValue(document.validity.until, false);
  if (until === null) {
    issues.push({ path: "validity.until", code: "required" });
    return issues;
  }
  const at = localTimeValue(localMinuteNow(now, timezone), false) ?? now.getTime();
  const from =
    document.validity.from === null ? null : localTimeValue(document.validity.from, false);
  if (until <= at) issues.push({ path: "validity.until", code: "past" });
  else if (until - Math.max(at, from ?? at) > NOTICE_LIMITS.maxDays * DAY_MS) {
    issues.push({ path: "validity.until", code: "too_long" });
  }
  return issues;
}

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

function localWords(value: string, locale: string): string | null {
  const time = localTimeValue(value, false);
  if (time === null) return null;
  // The date in words and the time as written: the same text with any ICU version.
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(time));
  return `${date}, ${value.slice(11, 16)}`;
}

/**
 * «Del 1 de diciembre de 2026, 08:00 al 3 de diciembre de 2026, 18:00» or «Hasta el 3 de
 * diciembre de 2026, 18:00»; null without an end.
 */
export function describeNoticeValidity(validity: NoticeValidity, locale = "es"): string | null {
  const until = validity.until === null ? null : localWords(validity.until, locale);
  if (until === null) return null;
  const from = validity.from === null ? null : localWords(validity.from, locale);
  if (locale.startsWith("en")) {
    return from ? `From ${from} to ${until}` : `Until ${until}`;
  }
  return capitalize(from ? `del ${from} al ${until}` : `hasta el ${until}`);
}
