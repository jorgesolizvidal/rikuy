import { faqPageJsonLd, groupFaqs, PORTAL_PATHS, serializeJsonLd } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RichTextView } from "@/components/rich-text";
import { portalFaqs, portalOrigin } from "@/server/portal-content";
import { portalViewWith } from "@/server/portal-view";

import "../faq.css";

interface FaqPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: FaqPageProps): Promise<Metadata> {
  const view = await portalViewWith((await params).host, "portal");
  if (view === null) return {};
  const { siteName } = view.resolved.presentation.identity;
  const description = `Respuestas a lo que más preguntan quienes visitan ${siteName}: cómo llegar, horarios, servicios y más.`;
  return {
    title: "Preguntas frecuentes",
    description,
    alternates: { canonical: PORTAL_PATHS.faqs },
    openGraph: { title: `Preguntas frecuentes | ${siteName}`, description },
  };
}

/**
 * The municipality's frequently asked questions (A · Paso 5.2, ADR-074), grouped by topic.
 * Every answer is on the page (search engines only take what visitors can read), each question
 * has its anchor (the assistant's citations land on it) and the page carries FAQPage data.
 */
export default async function FaqPage({ params }: FaqPageProps) {
  const host = (await params).host;
  const view = await portalViewWith(host, "portal");
  if (view === null) notFound();
  const faqs = await portalFaqs(view);
  const groups = groupFaqs(faqs);
  const { siteName } = view.resolved.presentation.identity;
  const jsonLd =
    faqs.length > 0
      ? serializeJsonLd(
          faqPageJsonLd(faqs, {
            url: `${portalOrigin(view)}${PORTAL_PATHS.faqs}`,
            portalName: siteName,
          }),
        )
      : null;

  return (
    <div className="portal-page faq-page">
      {jsonLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      ) : null}
      <header className="faq-head">
        <h1 className="portal-page-title">Preguntas frecuentes</h1>
        <p className="portal-lead">
          Lo que más preguntan quienes visitan {siteName}, respondido por el municipio.
        </p>
        {groups.length > 1 ? (
          <nav aria-label="Temas" className="faq-topics">
            {groups.map((group) => (
              <a key={group.topic} href={`#tema-${group.topic}`}>
                {group.name}
              </a>
            ))}
          </nav>
        ) : null}
      </header>
      {groups.length === 0 ? (
        <p className="portal-empty">Pronto publicaremos aquí las preguntas más frecuentes.</p>
      ) : (
        groups.map((group) => (
          <section
            key={group.topic}
            id={`tema-${group.topic}`}
            className="faq-group"
            aria-labelledby={`tema-${group.topic}-titulo`}
          >
            <h2 id={`tema-${group.topic}-titulo`}>{group.name}</h2>
            <ul className="faq-list">
              {group.faqs.map((faq) => (
                <li key={faq.slug} id={faq.slug} className="faq-item">
                  <h3>{faq.question}</h3>
                  <p className="faq-answer">{faq.answer}</p>
                  {faq.body.length > 0 ? (
                    <div className="portal-prose">
                      <RichTextView blocks={faq.body} headingOffset={1} />
                    </div>
                  ) : null}
                  {faq.place ? (
                    <p className="faq-place">
                      Sobre{" "}
                      <a
                        href={
                          faq.place.kind === "event"
                            ? PORTAL_PATHS.event(faq.place.slug)
                            : PORTAL_PATHS.destination(faq.place.slug)
                        }
                      >
                        {faq.place.title}
                      </a>
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
