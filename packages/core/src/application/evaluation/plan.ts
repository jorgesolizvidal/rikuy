import { ASSISTANT_GOLD } from "../assistant/gold-set";
import { goldSplit, type GoldCase } from "../assistant/gold";
import { COPILOT_GOLD, type CopilotGoldCase } from "./copilot-gold";
import type { EvalResultRow, EvalSplit, EvalSuite } from "./ports";

/**
 * What a run asks, in order (ADR-045): every development and security case once, every
 * held-out case three times. The order spreads the held-out repetitions apart, so a run
 * split over two days does not ask the same question twice in a row.
 */

export const HELD_OUT_REPETITIONS = 3;

export interface EvalItem {
  readonly caseId: string;
  readonly repetition: number;
  readonly split: EvalSplit;
}

/** A short, stable fingerprint (cyrb53) of a dataset, to tell versions apart. */
export function fingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

export const ASSISTANT_DATASET = `rikuy-gold/v2#${fingerprint(JSON.stringify(ASSISTANT_GOLD))}`;
export const COPILOT_DATASET = `rikuy-copilot-gold/v1#${fingerprint(JSON.stringify(COPILOT_GOLD))}`;

export function datasetOf(suite: EvalSuite): string {
  return suite === "assistant" ? ASSISTANT_DATASET : COPILOT_DATASET;
}

export function assistantItems(cases: readonly GoldCase[] = ASSISTANT_GOLD): EvalItem[] {
  const of = (split: EvalSplit, repetition = 1) =>
    cases
      .filter((gold) => goldSplit(gold.id) === split)
      .map((gold) => ({ caseId: gold.id, repetition, split }));
  return [
    ...of("dev"),
    ...of("heldout", 1),
    ...of("security"),
    ...of("heldout", 2),
    ...of("heldout", 3),
  ];
}

export function copilotItems(cases: readonly CopilotGoldCase[] = COPILOT_GOLD): EvalItem[] {
  return cases.map((gold) => ({ caseId: gold.id, repetition: 1, split: "copilot" as const }));
}

export function itemsOf(suite: EvalSuite): EvalItem[] {
  return suite === "assistant" ? assistantItems() : copilotItems();
}

/**
 * The next items to run: those without a result, or whose result was not evaluated (a
 * quota or the provider). `skip` leaves out what cannot run now (no demo B, no trap data).
 */
export function pendingItems(
  items: readonly EvalItem[],
  results: readonly Pick<EvalResultRow, "caseId" | "repetition" | "pass">[],
  skip: (item: EvalItem) => boolean = () => false,
): EvalItem[] {
  const done = new Set(
    results
      .filter((result) => result.pass !== null)
      .map((result) => `${result.caseId}#${result.repetition}`),
  );
  return items.filter((item) => !done.has(`${item.caseId}#${item.repetition}`) && !skip(item));
}
