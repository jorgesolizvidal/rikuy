"use client";

import { useRouter } from "next/navigation";
import { useCallback, useId, useRef, useState, type ChangeEvent } from "react";

import { ModelViewer, type ModelCanvasHandle } from "@/components/model-viewer/model-viewer";

import { saveModelPosterAction } from "./actions";

/** Server Actions accept 1 MB: the capture stays below with room for the form. */
const MAX_CAPTURE_BYTES = 900 * 1024;

const POSTER_FAILURES = {
  forbidden: "Tu rol no permite cambiar la imagen de este modelo.",
  signed_out: "Tu sesión venció. Inicia sesión de nuevo.",
  not_found: "No encontramos este modelo.",
  not_ready: "El modelo todavía no está listo.",
  invalid: "No pudimos usar esa imagen. Inténtalo de nuevo.",
  error: "No pudimos guardar la imagen. Inténtalo de nuevo en unos segundos.",
} as const;

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/**
 * A photo chosen as poster (ADR-048), shrunk in the browser to at most 1280 px so it fits a
 * Server Action; the server re-encodes it anyway. The canvas also applies the photo's
 * orientation and drops its metadata (location included).
 */
async function shrinkPhoto(file: File): Promise<Blob | null> {
  if (!PHOTO_TYPES.includes(file.type)) return null;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.9, 0.8, 0.7, 0.6]) {
    let blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/webp", quality),
    );
    // A browser that cannot write WebP answers PNG: JPEG is smaller.
    if (blob && blob.type !== "image/webp") {
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
    }
    if (blob && blob.size <= MAX_CAPTURE_BYTES) return blob;
  }
  return null;
}

interface ModelPreviewProps {
  readonly slug: string;
  readonly versionId: string;
  readonly modelUrl: string;
  readonly posterUrl: string | null;
  readonly posterSize: { readonly width: number; readonly height: number } | null;
  readonly label: string;
  readonly canEdit: boolean;
}

/**
 * The model's image and its 3D preview. A ready model without a poster gets one captured
 * here, with the same viewer the portal uses (the server has no GPU). Editors can turn the
 * model and use any view instead.
 */
export function ModelPreview({
  slug,
  versionId,
  modelUrl,
  posterUrl,
  posterSize,
  label,
  canEdit,
}: ModelPreviewProps) {
  const router = useRouter();
  const photoId = useId();
  const automatic = canEdit && posterUrl === null;
  const [open, setOpen] = useState(automatic);
  const [handle, setHandle] = useState<ModelCanvasHandle | null>(null);
  const [message, setMessage] = useState(automatic ? "Preparando la imagen del modelo…" : "");
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const captured = useRef(false);

  const send = useCallback(
    async (blob: Blob | null, done: string, problem: string = POSTER_FAILURES.invalid) => {
      if (!blob) {
        setSaving(false);
        setFailed(true);
        return setMessage(problem);
      }
      const form = new FormData();
      form.set("slug", slug);
      form.set("versionId", versionId);
      form.set(
        "poster",
        blob,
        blob.type === "image/webp"
          ? "poster.webp"
          : blob.type === "image/jpeg"
            ? "poster.jpg"
            : "poster.png",
      );
      const result = await saveModelPosterAction(form).catch(() => ({ status: "error" as const }));
      setSaving(false);
      if (result.status !== "saved") {
        setFailed(true);
        return setMessage(POSTER_FAILURES[result.status]);
      }
      setFailed(false);
      setMessage(done);
      router.refresh();
    },
    [router, slug, versionId],
  );

  const save = useCallback(
    async (viewer: ModelCanvasHandle, done: string) => {
      setSaving(true);
      await send(await viewer.capture(MAX_CAPTURE_BYTES), done);
    },
    [send],
  );

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSaving(true);
    setFailed(false);
    setMessage("Preparando la foto…");
    const blob = await shrinkPhoto(file).catch(() => null);
    await send(
      blob,
      "Imagen actualizada con tu foto.",
      PHOTO_TYPES.includes(file.type)
        ? "No pudimos leer esa foto. Prueba con otra."
        : "Usa una foto JPG, PNG o WebP.",
    );
  }

  const ready = useCallback(
    (viewer: ModelCanvasHandle) => {
      setHandle(viewer);
      if (automatic && !captured.current) {
        captured.current = true;
        void save(viewer, "Imagen del modelo lista. Puedes girarlo y elegir otra vista.");
      }
    },
    [automatic, save],
  );

  return (
    <div className="model-preview">
      {open ? (
        <ModelViewer
          url={modelUrl}
          label={`Modelo 3D: ${label}. Arrastra o usa las flechas para girarlo.`}
          onReady={ready}
          onFailure={() => {
            setFailed(true);
            setMessage(
              "Este navegador no pudo dibujar el modelo (sin WebGL o no cargó). Prueba en otro navegador.",
            );
          }}
        />
      ) : (
        <div className="panorama-thumb model-thumb" data-empty={posterUrl === null}>
          {posterUrl ? (
            // Short-lived signed URL from Storage: next/image would cache it past expiry.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={posterUrl}
              alt={`Imagen del modelo ${label}`}
              width={posterSize?.width}
              height={posterSize?.height}
              loading="lazy"
            />
          ) : (
            <span>Sin imagen todavía</span>
          )}
        </div>
      )}
      <div className="row-actions">
        {canEdit ? (
          <>
            <input
              id={photoId}
              type="file"
              className="visually-hidden"
              accept={PHOTO_TYPES.join(",")}
              disabled={saving}
              onChange={(event) => void choosePhoto(event)}
            />
            <label htmlFor={photoId} className="button button-quiet" aria-disabled={saving}>
              Subir una foto como imagen
            </label>
          </>
        ) : null}
        {open ? (
          <>
            {canEdit ? (
              <button
                type="button"
                className="button button-quiet"
                disabled={!handle || saving}
                onClick={() => handle && void save(handle, "Imagen actualizada con esta vista.")}
              >
                {saving ? "Guardando…" : "Usar esta vista como imagen"}
              </button>
            ) : null}
            <button
              type="button"
              className="button button-quiet"
              disabled={!handle}
              onClick={() => handle?.resetView()}
            >
              Restablecer vista
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                setOpen(false);
                setHandle(null);
              }}
            >
              Cerrar el visor
            </button>
          </>
        ) : (
          <button type="button" className="button button-quiet" onClick={() => setOpen(true)}>
            Ver en 3D
          </button>
        )}
      </div>
      <p className={failed ? "field-error" : "field-hint"} role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
