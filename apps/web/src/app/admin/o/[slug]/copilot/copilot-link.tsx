import { COPILOT_PATHS, type ProposalTarget } from "@rikuy/core";
import Link from "next/link";

/**
 * «Proponer con el Copilot» in an editor (ADR-042): opens the proposal page for this item;
 * the proposal starts from what is saved, so the note asks to save first.
 */
export function CopilotProposeLink({
  org,
  target,
}: {
  readonly org: string;
  readonly target: ProposalTarget;
}) {
  return (
    <section aria-labelledby="copilot-propose" className="copilot-link">
      <h2 id="copilot-propose">Copilot</h2>
      <p className="field-hint">
        Pide una propuesta de textos. La revisas campo por campo y lo que aceptes queda como
        borrador. Parte de lo último guardado.
      </p>
      <Link href={COPILOT_PATHS.propose(org, target)} className="button button-quiet">
        Proponer con el Copilot
      </Link>
    </section>
  );
}
