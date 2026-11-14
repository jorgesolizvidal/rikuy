/**
 * A few counts next to a list's title (ADR-062): what the portal has, never a figure the
 * municipality did not publish. A zero is left out, except the first one.
 */
export function ListingFacts({
  facts,
}: {
  readonly facts: readonly { readonly value: number; readonly label: string }[];
}) {
  const shown = facts.filter((fact, index) => index === 0 || fact.value > 0);
  if (shown.length === 0) return null;
  return (
    <dl className="portal-facts">
      {shown.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
