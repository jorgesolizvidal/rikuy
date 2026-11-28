import { PORTAL_PATHS, type PublishedFaq } from "@rikuy/core";

/**
 * «Preguntas frecuentes» on a destination's or an event's page (ADR-074): the questions about
 * that place with their answer, and a link to the full list. Its styles are in detail.css.
 */
export function PlaceFaqs({ faqs }: { readonly faqs: readonly PublishedFaq[] }) {
  if (faqs.length === 0) return null;
  return (
    <section aria-labelledby="preguntas-frecuentes" className="portal-detail-section">
      <h2 id="preguntas-frecuentes">Preguntas frecuentes</h2>
      <dl className="faq-place-list">
        {faqs.map((faq) => (
          <div key={faq.slug}>
            <dt>{faq.question}</dt>
            <dd>
              {faq.answer}{" "}
              {faq.body.length > 0 ? <a href={PORTAL_PATHS.faq(faq.slug)}>Más detalles</a> : null}
            </dd>
          </div>
        ))}
      </dl>
      <p className="portal-detail-more">
        <a href={PORTAL_PATHS.faqs}>Ver todas las preguntas frecuentes</a>
      </p>
    </section>
  );
}
