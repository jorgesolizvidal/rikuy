/**
 * Whether a notice is in force (ADR-069), from the instants the portal reads. The portal's
 * pages are cached, so the browser checks again with its own clock: a cached page never shows
 * a notice that ended or one that has not started. No schemas here: browser code imports it
 * from `@rikuy/core/geo`.
 */

export interface NoticeInstants {
  /** ISO 8601; null: in force since it was published. */
  readonly startsAt: string | null;
  readonly endsAt: string;
}

export function noticeInForce(notice: NoticeInstants, now: Date): boolean {
  const at = now.getTime();
  const ends = Date.parse(notice.endsAt);
  if (!Number.isFinite(ends) || at >= ends) return false;
  if (notice.startsAt === null) return true;
  const starts = Date.parse(notice.startsAt);
  return Number.isFinite(starts) && at >= starts;
}

/** The ones in force now, the one that ends sooner first. */
export function noticesInForce<T extends NoticeInstants>(notices: readonly T[], now: Date): T[] {
  return notices
    .filter((notice) => noticeInForce(notice, now))
    .sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt));
}
