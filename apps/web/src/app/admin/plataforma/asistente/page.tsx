import type { Metadata } from "next";

import { EvaluationPage } from "../_evaluation/evaluation-page";

export const metadata: Metadata = { title: "Evaluar el asistente" };

/** A batch: five cases with the real model, spaced (about a minute and a half). */
export const maxDuration = 300;

export default async function AssistantEvaluationPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly corrida?: string | string[] }>;
}) {
  const run = (await searchParams).corrida;
  return <EvaluationPage suite="assistant" runId={typeof run === "string" ? run : null} />;
}
