import { PORTAL_PATHS, storyTeller, type PublishedStory } from "@rikuy/core";

import "./memory.css";

/**
 * «Lo que cuenta la comunidad» on a destination's page (ADR-069): its stories, each always
 * attributed, with a link to read it whole on /memoria.
 */
export function PlaceStories({ stories }: { readonly stories: readonly PublishedStory[] }) {
  if (stories.length === 0) return null;
  return (
    <section aria-labelledby="lo-que-cuenta" className="portal-detail-section">
      <h2 id="lo-que-cuenta">Lo que cuenta la comunidad</h2>
      <ul className="memory-place-list">
        {stories.map((story) => {
          const teller = storyTeller(story);
          return (
            <li key={story.slug}>
              <h3>
                <a href={PORTAL_PATHS.story(story.slug)}>{story.title}</a>
              </h3>
              <p className="memory-teller">
                {teller === "Anónimo" ? "Relato anónimo" : `Relato de ${teller}`}
                {story.community ? ` · ${story.community}` : ""}
              </p>
              {story.summary ? <p>{story.summary}</p> : null}
            </li>
          );
        })}
      </ul>
      <p className="portal-detail-more">
        <a href={PORTAL_PATHS.memory}>Ver todos los relatos</a>
      </p>
    </section>
  );
}
