import type { Metadata } from "next";

import { EvaluationPage } from "../_evaluation/evaluation-page";

export const metadata: Metadata = { title: "Evaluar el Copilot" };

/** A batch: two cases with the real model, spaced (about a minute and a half). */
export const maxDuration = 300;

export default async function CopilotEvaluationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly corrida?: string | string[] }>;
}) {
  const run = (await searchParams).corrida;
  return <EvaluationPage suite="copilot" runId={typeof run === "string" ? run : null} />;
}
