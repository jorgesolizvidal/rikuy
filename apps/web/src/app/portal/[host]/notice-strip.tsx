"use client";

import { noticesInForce } from "@rikuy/core/geo";
import { useEffect, useState, type ReactNode } from "react";

/**
 * The municipality's notices (ADR-069): a strip on every page and, in a place's page, the
 * ones about that place. Pages are cached, so the server renders the ones in force when the
 * page was built and the browser checks again with its own clock: an ended notice never
 * stays on screen, and one that started meanwhile shows up.
 */

export interface NoticeDto {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  /** Instants (ISO 8601); no start: in force since it was published. */
  readonly startsAt: string | null;
  readonly endsAt: string;
  /** Its anchor in /avisos. */
  readonly href: string;
  readonly place: {
    readonly kind: "destination" | "event";
    readonly slug: string;
    readonly title: string;
    readonly href: string;
  } | null;
}

/** The strip shows this many; the rest are in /avisos. */
const STRIP_LIMIT = 3;

/** The ones in force, by the server's clock first and the browser's after hydration. */
function useInForce(notices: readonly NoticeDto[], initial: readonly string[]): NoticeDto[] {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the browser's clock exists only here
    setNow(new Date());
    // Checked again every minute: a page left open drops a notice that ends.
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  if (now === null) {
    const shown = new Set(initial);
    return notices.filter((notice) => shown.has(notice.slug));
  }
  return noticesInForce(notices, now);
}

function NoticeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" focusable="false">
      <path
        d="M12 4 2.5 20h19zM12 10v4.5M12 17.2v.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function NoticeStrip({
  notices,
  initial,
}: {
  readonly notices: readonly NoticeDto[];
  readonly initial: readonly string[];
}) {
  const inForce = useInForce(notices, initial);
  if (inForce.length === 0) return null;
  const shown = inForce.slice(0, STRIP_LIMIT);
  return (
    <section className="portal-notices" aria-label="Avisos del municipio">
      <ul>
        {shown.map((notice) => (
          <li key={notice.slug}>
            <NoticeIcon />
            <p>
              <strong>{notice.title}</strong>
              {notice.summary ? <span> {notice.summary}</span> : null}{" "}
              <a href={notice.href}>
                Ver el aviso<span className="visually-hidden"> «{notice.title}»</span>
              </a>
            </p>
          </li>
        ))}
      </ul>
      {inForce.length > shown.length ? (
        <p className="portal-notices-more">
          <a href="/avisos">Ver los {inForce.length} avisos</a>
        </p>
      ) : null}
    </section>
  );
}

/** In a place's page: the notices about it, first thing in «Para tu visita». */
export function PlaceNotices({
  notices,
  initial,
}: {
  readonly notices: readonly NoticeDto[];
  readonly initial: readonly string[];
}) {
  const inForce = useInForce(notices, initial);
  if (inForce.length === 0) return null;
  return (
    <section className="portal-place-notices" aria-labelledby="avisos-del-lugar">
      <h3 id="avisos-del-lugar">{inForce.length === 1 ? "Aviso" : "Avisos"}</h3>
      <ul>
        {inForce.map((notice) => (
          <li key={notice.slug}>
            <NoticeIcon />
            <p>
              <strong>{notice.title}</strong>
              {notice.summary ? <span> {notice.summary}</span> : null}{" "}
              <a href={notice.href}>
                Ver el aviso<span className="visually-hidden"> «{notice.title}»</span>
              </a>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** In /avisos: one notice, while it is in force by the browser's clock. */
export function InForce({
  notice,
  initial,
  children,
}: {
  readonly notice: Pick<NoticeDto, "slug" | "startsAt" | "endsAt">;
  readonly initial: boolean;
  readonly children: ReactNode;
}) {
  const inForce = useInForce([notice as NoticeDto], initial ? [notice.slug] : []);
  return inForce.length > 0 ? children : null;
}

/** In /avisos: what to say when none is in force (also once the last one ends). */
export function NoNotices({
  notices,
  initial,
  children,
}: {
  readonly notices: readonly Pick<NoticeDto, "slug" | "startsAt" | "endsAt">[];
  readonly initial: readonly string[];
  readonly children: ReactNode;
}) {
  const inForce = useInForce(notices as readonly NoticeDto[], initial);
  return inForce.length === 0 ? children : null;
}
