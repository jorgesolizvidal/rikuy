import {
  RECOMMENDATION_SOURCE_LABELS,
  recommendationLinks,
  type OrganizationMembership,
  type Recommendation,
  type RecommendationFact,
} from "@rikuy/core";
import Link from "next/link";

/**
 * The Copilot's recommendations (ADR-054): each with «En qué se basa» — the facts it cites,
 * word for word — and the links of the platform (never the model's).
 */
export function RecommendationList({
  membership,
  items,
  facts,
  names,
}: {
  readonly membership: OrganizationMembership;
  readonly items: readonly Recommendation[];
  readonly facts: readonly RecommendationFact[];
  /** Content id → its name, so each link says which place it opens. */
  readonly names: ReadonlyMap<string, string>;
}) {
  return (
    <ol className="recommendations">
      {items.map((item, index) => {
        const cited = item.facts
          .map((id) => facts.find((fact) => fact.id === id))
          .filter((fact) => fact !== undefined);
        const links = recommendationLinks(membership, item, facts, names);
        return (
          <li key={`${index}-${item.title}`} className="recommendation">
            <h3>{item.title}</h3>
            <p>{item.why}</p>
            <div className="recommendation-facts">
              <p className="recommendation-facts-title">En qué se basa</p>
              <ul>
                {cited.map((fact) => (
                  <li key={fact.id}>
                    <span className="recommendation-source">
                      {RECOMMENDATION_SOURCE_LABELS[fact.source]}
                    </span>{" "}
                    {fact.text}
                  </li>
                ))}
              </ul>
            </div>
            {links.length > 0 ? (
              <ul className="recommendation-links">
                {links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
