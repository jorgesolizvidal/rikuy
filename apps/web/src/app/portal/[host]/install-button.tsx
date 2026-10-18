"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Mode = "hidden" | "prompt" | "ios";

/**
 * "Instalar" for the portal (manifest + icons already exist per municipality). Browsers
 * that support it offer their own install prompt; iPhone/iPad Safari has none, so it
 * gets the two steps to add it to the home screen. Hidden once installed.
 */
export function InstallButton({ siteName }: { readonly siteName: string }) {
  const [mode, setMode] = useState<Mode>("hidden");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      setMode("prompt");
    };
    const onInstalled = () => {
      setDeferred(null);
      setMode("hidden");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    const ios =
      /iphone|ipad|ipod/iu.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    // Deferred so the state change does not happen synchronously inside the effect.
    const timer = ios && !standalone ? window.setTimeout(() => setMode("ios"), 0) : undefined;
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  if (mode === "hidden") return null;

  if (mode === "ios") {
    return (
      <div className="portal-install">
        <button
          type="button"
          className="portal-button"
          aria-expanded={showSteps}
          aria-controls="portal-install-steps"
          onClick={() => setShowSteps((value) => !value)}
        >
          Instalar
        </button>
        {showSteps ? (
          <ol id="portal-install-steps" className="portal-install-steps">
            <li>Toca el botón «Compartir» de Safari.</li>
            <li>Elige «Agregar a inicio» para tener {siteName} como una app.</li>
          </ol>
        ) : null}
      </div>
    );
  }

  return (
    <div className="portal-install">
      <button
        type="button"
        className="portal-button"
        onClick={async () => {
          if (!deferred) return;
          await deferred.prompt();
          await deferred.userChoice;
          setDeferred(null);
          setMode("hidden");
        }}
      >
        Instalar
      </button>
    </div>
  );
}
