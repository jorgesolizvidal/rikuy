"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { ASSISTANT_ASK_EVENT, type AssistantAskDetail } from "@/lib/assistant-context";

import type { AssistantRequestFromPage } from "./assistant-panel";

/**
 * The assistant's floating button (ADR-038), on every page of the portal. Only the button
 * is in the page: the panel (and everything it needs) is downloaded when the visitor opens
 * it — or a moment before, when the pointer or the focus reaches the button.
 */
const loadPanel = () => import("./assistant-panel");
const AssistantPanel = dynamic(loadPanel, { ssr: false });

export interface AssistantLauncherProps {
  readonly name: string;
  /** The brand gives it a name (otherwise «Asistente»). */
  readonly named: boolean;
  readonly greeting: string;
  readonly siteName: string;
  /** The municipality has the assistant's voice (ADR-060): dictation and «Escuchar». */
  readonly voice: boolean;
}

export function AssistantLauncher(props: AssistantLauncherProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** A question another part of the page asked (the tour's guide buttons, ADR-040). */
  const [request, setRequest] = useState<AssistantRequestFromPage | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let count = 0;
    const asked = (event: Event) => {
      const detail = (event as CustomEvent<AssistantAskDetail>).detail;
      returnFocus.current = detail.returnFocus ?? null;
      count += 1;
      setRequest({
        id: count,
        question: detail.question,
        intent: detail.intent,
        tour: detail.tour,
      });
      setLoaded(true);
      setOpen(true);
    };
    window.addEventListener(ASSISTANT_ASK_EVENT, asked);
    return () => window.removeEventListener(ASSISTANT_ASK_EVENT, asked);
  }, []);
  const preload = useCallback(() => {
    void loadPanel();
  }, []);
  const close = useCallback(() => setOpen(false), []);
  // Back to the button once it is visible again (it is hidden while the panel is open).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const back = returnFocus.current;
      returnFocus.current = null;
      if (back?.isConnected) back.focus();
      else button.current?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="portal-assistant-launcher"
        aria-haspopup="dialog"
        aria-expanded={open}
        hidden={open}
        onPointerEnter={preload}
        onFocus={preload}
        onClick={() => {
          returnFocus.current = null;
          setLoaded(true);
          setOpen(true);
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" focusable="false">
          <path
            fill="currentColor"
            d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H10l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"
          />
          <circle cx="8.5" cy="10.5" r="1.3" fill="var(--brand)" />
          <circle cx="12" cy="10.5" r="1.3" fill="var(--brand)" />
          <circle cx="15.5" cy="10.5" r="1.3" fill="var(--brand)" />
        </svg>
        <span>{props.name}</span>
        <span className="visually-hidden">: hacer una pregunta</span>
      </button>
      {loaded ? <AssistantPanel {...props} open={open} onClose={close} request={request} /> : null}
    </>
  );
}
