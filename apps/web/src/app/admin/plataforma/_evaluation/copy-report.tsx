"use client";

import { useState } from "react";

/** «Copiar resultados»: the report and every answer as text, for the record. */
export function CopyReport({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button button-quiet"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        )
      }
    >
      {copied ? "Copiado" : "Copiar resultados"}
    </button>
  );
}
