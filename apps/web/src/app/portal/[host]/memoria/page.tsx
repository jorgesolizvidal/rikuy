import { PORTAL_PATHS, storyTeller, type PublishedStory } from "@rikuy/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { RichTextView } from "@/components/rich-text";
import { portalStories } from "@/server/portal-content";
import { portalViewWith } from "@/server/portal-view";

import "../memory.css";

interface MemoryPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: MemoryPageProps): Promise<Metadata> {
  const view = await portalViewWith((await params).host, "community_memory");
  if (view === null) return {};
  const { siteName } = view.resolved.presentation.identity;
  const description = `Historias, costumbres y recuerdos que cuentan los vecinos de ${siteName}.`;
  return {
    title: "Memoria de la comunidad",
    description,
    alternates: { canonical: PORTAL_PATHS.memory },
    openGraph: { title: `Memoria de la comunidad | ${siteName}`, description },
  };
}

/**
 * The community's stories (A · Paso 1.3, ADR-069): each with its anchor (the assistant's
 * citations land on it), who tells it — always attributed — and the destination it is about.
 */
export default async function MemoryPage({ params }: MemoryPageProps) {
  const view = await portalViewWith((await params).host, "community_memory");
  if (view === null) notFound();
  const stories = await portalStories(view);
  const { siteName } = view.resolved.presentation.identity;
  const { defaultLocale } = view.context.tenant;

  return (
    <div className="portal-page memory-page">
      <header className="memory-head">
        <h1 className="portal-page-title">Memoria de la comunidad</h1>
        <p className="portal-lead">
          Lo que cuentan los vecinos de {siteName}: historias, costumbres y recuerdos, con sus
          palabras. Son relatos personales, publicados con el permiso de quien los cuenta.
        </p>
      </header>
      {stories.length === 0 ? (
        <p className="portal-empty">Pronto publicaremos aquí los relatos de la comunidad.</p>
      ) : (
        <ul className="memory-list">
          {stories.map((story) => (
            <li key={story.slug}>
              <StoryArticle story={story} locale={defaultLocale} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StoryArticle({
  story,
  locale,
}: {
  readonly story: PublishedStory;
  readonly locale: string;
}) {
  const headingId = `relato-${story.slug}`;
  const teller = storyTeller(story);
  return (
    <article id={story.slug} className="memory-story" aria-labelledby={headingId}>
      <h2 id={headingId}>{story.title}</h2>
      <p className="memory-teller">
        {teller === "Anónimo" ? "Relato anónimo" : `Relato de ${teller}`}
        {story.community ? <span> · {story.community}</span> : null}
      </p>
      {story.summary ? <p className="memory-summary">{story.summary}</p> : null}
      <div className="portal-prose">
        <RichTextView blocks={story.body} />
      </div>
      <p className="memory-meta">
        {story.place ? (
          <>
            Sobre <a href={PORTAL_PATHS.destination(story.place.slug)}>{story.place.title}</a>
            {" · "}
          </>
        ) : null}
        Publicado el{" "}
        <time dateTime={story.publishedAt}>
          {new Date(story.publishedAt).toLocaleDateString(locale, {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
        </time>
      </p>
    </article>
  );
}
