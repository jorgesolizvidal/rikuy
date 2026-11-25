import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { portalViewWith } from "@/server/portal-view";

import { AskShell } from "../ask-shell";

interface AskPageProps {
  readonly params: Promise<{ host: string }>;
}

export async function generateMetadata({ params }: AskPageProps): Promise<Metadata> {
  const view = await portalViewWith((await params).host, "assistant");
  const name = view?.resolved.presentation.assistant?.name.trim();
  return { title: name ? `Pregúntale a ${name}` : "Pregúntale al asistente" };
}

/** «Pregúntale a …» for the whole municipality (ADR-071): its general QR opens this page. */
export default async function AskPage({ params }: AskPageProps) {
  const view = await portalViewWith((await params).host, "assistant");
  if (view === null) notFound();
  return <AskShell view={view} place={null} />;
}
