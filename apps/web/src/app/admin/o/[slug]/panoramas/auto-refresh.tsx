"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While something is processing, re-reads the list every few seconds (only when visible). */
export function AutoRefresh({ active }: { readonly active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, router]);
  return null;
}
