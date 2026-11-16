import { describeNoticeValidity, localMinuteNow, PORTAL_PATHS } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RichTextView } from "@/components/rich-text";
import { portalNoticeView, portalNotices } from "@/server/portal-content";
import { portalView } from "@/server/portal-view";

import { InForce, NoNotices } from "../notice-strip";

interface NoticesPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: NoticesPageProps): Promise<Metadata> {
  const view = await portalView((await params).host);
  if (view === null) return {};
  return {
    title: "Avisos",
    description: `Avisos vigentes de ${view.resolved.presentation.identity.siteName}.`,
    alternates: { canonical: PORTAL_PATHS.notices },
    // Notices come and go: the page is for visitors, not for search engines (ADR-069).
    robots: { index: false, follow: true },
  };
}

/**
 * The municipality's notices in force (ADR-069), each with its anchor, its validity in the
 * municipality's time and, if it is about a place, a link to it. The page is cached: the
 * browser hides the ones that ended and shows the ones that started meanwhile.
 */
export default async function NoticesPage({ params }: NoticesPageProps) {
  const view = await portalView((await params).host);
  if (view === null) notFound();
  const [notices, shown] = await Promise.all([portalNotices(view), portalNoticeView(view)]);
  const { timezone, defaultLocale } = view.context.tenant;
  const { siteName } = view.resolved.presentation.identity;
  const initial = new Set(shown.initial);

  return (
    <article className="portal-page portal-notices-page">
      <h1 className="portal-page-title">Avisos</h1>
      <p className="portal-lead">
        Lo que {siteName} avisa a quienes lo visitan: cortes, cambios de horario, accesos y más.
        Cada aviso dice hasta cuándo vale.
      </p>
      <NoNotices notices={shown.notices} initial={shown.initial}>
        <p className="portal-empty">No hay avisos vigentes.</p>
      </NoNotices>
      <ul className="portal-notice-list">
        {notices.map((notice) => {
          const validity = describeNoticeValidity(
            {
              from: notice.startsAt ? localMinuteNow(new Date(notice.startsAt), timezone) : null,
              until: localMinuteNow(new Date(notice.endsAt), timezone),
            },
            defaultLocale,
          );
          return (
            <InForce key={notice.slug} notice={notice} initial={initial.has(notice.slug)}>
              <li>
                <article id={notice.slug} aria-labelledby={`aviso-${notice.slug}`}>
                  <h2 id={`aviso-${notice.slug}`}>{notice.title}</h2>
                  {validity ? <p className="portal-notice-validity">{validity}</p> : null}
                  {notice.summary ? (
                    <p className="portal-notice-summary">{notice.summary}</p>
                  ) : null}
                  {notice.body.length > 0 ? (
                    <div className="portal-prose">
                      <RichTextView blocks={notice.body} />
                    </div>
                  ) : null}
                  {notice.place ? (
                    <p className="portal-notice-place">
                      Sobre{" "}
                      <a
                        href={
                          notice.place.kind === "destination"
                            ? PORTAL_PATHS.destination(notice.place.slug)
                            : PORTAL_PATHS.event(notice.place.slug)
                        }
                      >
                        {notice.place.title}
                      </a>
                    </p>
                  ) : null}
                </article>
              </li>
            </InForce>
          );
        })}
      </ul>
    </article>
  );
}
