"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

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
}

export function AssistantLauncher(props: AssistantLauncherProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const preload = useCallback(() => {
    void loadPanel();
  }, []);
  const close = useCallback(() => setOpen(false), []);
  // Back to the button once it is visible again (it is hidden while the panel is open).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) button.current?.focus();
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
      {loaded ? <AssistantPanel {...props} open={open} onClose={close} /> : null}
    </>
  );
}
