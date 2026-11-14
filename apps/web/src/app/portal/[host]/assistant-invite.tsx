"use client";

import { openAssistant } from "@/lib/assistant-context";

/** The home's invitation to ask (ADR-062): opens the same assistant as the floating button. */
export function AssistantInvite({ label }: { readonly label: string }) {
  return (
    <button
      type="button"
      className="portal-button portal-button-primary"
      aria-haspopup="dialog"
      onClick={(event) => openAssistant(event.currentTarget)}
    >
      {label}
    </button>
  );
}
