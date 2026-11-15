"use client";

import { readScannedCode } from "@rikuy/core/passport-client";
import { useEffect, useRef, useState } from "react";

/**
 * «Escanear el código del lugar» (C3 · Paso 5, ADR-064): reads a stamp's QR with the phone's
 * camera, in the page. The image never leaves the phone (the browser's own barcode reader looks
 * at it) and only a stamp of THIS portal is opened; any other link is reported, never followed.
 * Where the browser cannot read codes (iPhone, most computers), it says to use the camera app.
 * The camera starts only when the visitor presses the button and stops when the dialog closes.
 */

interface DetectedBarcode {
  readonly rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

type Phase = "starting" | "scanning" | "unsupported" | "denied" | "no-camera" | "opening";

const MESSAGE: Record<Exclude<Phase, "scanning">, string> = {
  starting: "Abriendo la cámara…",
  opening: "Abriendo el sello…",
  unsupported:
    "Este navegador no puede leer códigos dentro de la página. Abre la cámara de tu teléfono y apunta al código del pasaporte: te llevará a la página del sello.",
  denied:
    "No diste permiso para usar la cámara. Puedes permitirlo en el navegador, o abrir la cámara de tu teléfono y apuntar al código.",
  "no-camera":
    "No encontramos una cámara en este dispositivo. Abre esta página en tu teléfono, o usa su cámara para leer el código.",
};

/** Looks for a code a few times per second, not on every frame. */
const SCAN_EVERY_MS = 250;

async function detectorClass(): Promise<BarcodeDetectorClass | null> {
  const Detector = (window as unknown as { BarcodeDetector?: BarcodeDetectorClass })
    .BarcodeDetector;
  if (!Detector) return null;
  try {
    const formats = (await Detector.getSupportedFormats?.()) ?? ["qr_code"];
    return formats.includes("qr_code") ? Detector : null;
  } catch {
    return null;
  }
}

export function QrScanner() {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [note, setNote] = useState("");

  function stop() {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }

  useEffect(() => stop, []);

  async function open() {
    setNote("");
    setPhase("starting");
    dialog.current?.showModal();
    const Detector = await detectorClass();
    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      setPhase("unsupported");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (error) {
      const name = (error as DOMException).name;
      setPhase(
        name === "NotAllowedError" || name === "SecurityError"
          ? "denied"
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? "no-camera"
            : "unsupported",
      );
      return;
    }
    // The dialog may have been closed while the camera was starting.
    if (!dialog.current?.open || !video.current) {
      stop();
      return;
    }
    video.current.srcObject = stream.current;
    await video.current.play().catch(() => undefined);
    setPhase("scanning");
    const detector = new Detector({ formats: ["qr_code"] });
    const look = async () => {
      if (!stream.current || !video.current) return;
      try {
        const found = await detector.detect(video.current);
        for (const code of found) {
          const read = readScannedCode(code.rawValue, window.location.origin);
          if (read.kind === "stamp") {
            stop();
            setPhase("opening");
            window.location.assign(read.path);
            return;
          }
          setNote(
            read.kind === "other"
              ? "Ese código no es un sello del pasaporte de este portal."
              : "Ese código no es un enlace. Busca el código del pasaporte del lugar.",
          );
        }
      } catch {
        // A frame that could not be read: try the next one.
      }
      timer.current = window.setTimeout(() => void look(), SCAN_EVERY_MS);
    };
    void look();
  }

  function close() {
    stop();
    dialog.current?.close();
  }

  return (
    <>
      <button
        ref={opener}
        type="button"
        className="portal-button portal-button-primary qr-scan-button"
        onClick={() => void open()}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" focusable="false">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"
          />
        </svg>
        Escanear el código del lugar
      </button>
      <dialog
        ref={dialog}
        className="qr-scanner"
        aria-labelledby="qr-scanner-titulo"
        onClose={() => {
          stop();
          setPhase(null);
          opener.current?.focus();
        }}
      >
        <div className="qr-scanner-bar">
          <h2 id="qr-scanner-titulo">Escanear el código del lugar</h2>
          <button type="button" className="portal-button" onClick={close}>
            Cerrar
          </button>
        </div>
        <div className="qr-scanner-view" data-phase={phase ?? undefined}>
          <video ref={video} muted playsInline aria-label="Vista de la cámara" />
          {phase === "scanning" ? <span className="qr-scanner-frame" aria-hidden="true" /> : null}
        </div>
        <p className="qr-scanner-status" role="status" aria-live="polite">
          {phase === null
            ? ""
            : phase === "scanning"
              ? note || "Apunta al código del pasaporte que está en el lugar."
              : MESSAGE[phase]}
        </p>
        <p className="qr-scanner-note">
          La imagen de la cámara no sale de tu teléfono: solo se abre el sello de este portal.
        </p>
      </dialog>
    </>
  );
}
