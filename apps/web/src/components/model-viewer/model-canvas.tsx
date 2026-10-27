"use client";

import { useEffect, useRef } from "react";
import {
  Box3,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * The 3D model viewer (ADR-026): three.js with KTX2 (Basis transcoder served from our own
 * origin) and Meshopt. Always loaded with next/dynamic (ssr: false), so three never enters
 * a page's initial bundle. The same settings draw the panel's preview, its poster capture
 * and the portal's model points in a tour (ADR-033), so the poster looks like what visitors
 * see.
 *
 * Color fidelity: sRGB output, Khronos PBR Neutral tone mapping (made to keep base colors)
 * and a neutral room environment; no extra colored lights.
 *
 * Nothing moves by itself (no auto-rotation, no inertia): the view changes only when the
 * visitor drags, zooms or uses the keys, so "reduce motion" needs nothing else. Keys, with
 * the canvas focused: arrows turn the model, + and − zoom, Home goes back to the first view.
 * Unmounting frees the model, its textures and the WebGL context at once (a phone's video
 * memory is the scarce resource).
 */
export interface ModelCanvasHandle {
  /** The current view as an image (WebP when the browser can encode it, else PNG). */
  capture(maxBytes: number): Promise<Blob | null>;
  resetView(): void;
}

/** "webgl": no WebGL here; "load": the file did not load; "context": the GPU dropped it. */
export type ModelCanvasFailure = "webgl" | "load" | "context";

export interface ModelCanvasProps {
  readonly url: string;
  /** Accessible name of the canvas (the page gives the text alternative next to it). */
  readonly label: string;
  /** Keep the frame readable for `capture()` (the panel); the portal does not need it. */
  readonly capturable?: boolean | undefined;
  readonly onReady?: ((handle: ModelCanvasHandle) => void) | undefined;
  /** Share of the file downloaded (0–1), while it loads and its size is known. */
  readonly onProgress?: ((fraction: number) => void) | undefined;
  /** WebGL or the file could not load: the page says so and keeps working. */
  readonly onFailure?: ((reason: ModelCanvasFailure) => void) | undefined;
}

/** One key press: about 15° of turn, or a tenth closer or farther. */
const KEY_TURN = Math.PI / 12;
const KEY_ZOOM = 1.1;

const TRANSCODER_PATH = `/vendor/three/${process.env.NEXT_PUBLIC_THREE_VERSION}/basis/`;

function disposeTree(root: Object3D) {
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value && typeof value === "object" && (value as Texture).isTexture) {
          (value as Texture).dispose();
        }
      }
      material.dispose();
    }
  });
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export default function ModelCanvas({
  url,
  label,
  capturable = true,
  onReady,
  onProgress,
  onFailure,
}: ModelCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onProgress, onFailure });
  const labelRef = useRef(label);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    callbacks.current = { onReady, onProgress, onFailure };
  }, [onReady, onProgress, onFailure]);
  // The name may change without rebuilding the viewer (and downloading the model again).
  useEffect(() => {
    labelRef.current = label;
    canvasRef.current?.setAttribute("aria-label", label);
  }, [label]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: capturable,
      });
    } catch {
      callbacks.current.onFailure?.("webgl");
      return;
    }
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const canvas = renderer.domElement;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", labelRef.current);
    canvas.tabIndex = 0;
    element.appendChild(canvas);
    canvasRef.current = canvas;

    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    const camera = new PerspectiveCamera(40, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    // The panel may shift the model to frame its poster; visitors only turn and zoom.
    controls.enablePan = capturable;
    const home = { position: new Vector3(), target: new Vector3() };
    const resetView = () => {
      camera.position.copy(home.position);
      controls.target.copy(home.target);
      controls.update();
    };

    const render = () => {
      if (!disposed) renderer.render(scene, camera);
    };
    const resize = () => {
      const width = element.clientWidth || 1;
      const height = element.clientHeight || 1;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    controls.addEventListener("change", render);
    const observer = new ResizeObserver(resize);
    observer.observe(element);

    const ktx2 = new KTX2Loader().setTranscoderPath(TRANSCODER_PATH).detectSupport(renderer);
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    let model: Object3D | null = null;

    // Our own keys: OrbitControls' arrows pan, which loses the model off the screen.
    const keydown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const turn: Partial<Record<string, () => void>> = {
        ArrowLeft: () => controls.rotateLeft(KEY_TURN),
        ArrowRight: () => controls.rotateLeft(-KEY_TURN),
        ArrowUp: () => controls.rotateUp(KEY_TURN),
        ArrowDown: () => controls.rotateUp(-KEY_TURN),
        "+": () => controls.dollyIn(KEY_ZOOM),
        "=": () => controls.dollyIn(KEY_ZOOM),
        "-": () => controls.dollyOut(KEY_ZOOM),
        Home: resetView,
      };
      const action = turn[event.key];
      if (!action || model === null) return;
      event.preventDefault();
      action();
      controls.update();
    };
    canvas.addEventListener("keydown", keydown);

    loader
      .loadAsync(url, (event) => {
        if (!disposed && event.lengthComputable && event.total > 0) {
          callbacks.current.onProgress?.(Math.min(1, event.loaded / event.total));
        }
      })
      .then((gltf) => {
        if (disposed) {
          disposeTree(gltf.scene);
          return;
        }
        model = gltf.scene;
        scene.add(model);
        // Frame the whole model from a three-quarter view.
        const box = new Box3().setFromObject(model);
        const size = box.getSize(new Vector3()).length() || 1;
        const center = box.getCenter(new Vector3());
        camera.near = size / 100;
        camera.far = size * 100;
        home.target.copy(center);
        home.position
          .copy(center)
          .add(new Vector3(0.6, 0.35, 0.75).normalize().multiplyScalar(size * 1.1));
        camera.position.copy(home.position);
        controls.target.copy(home.target);
        controls.update();
        resize();
        callbacks.current.onReady?.({
          async capture(maxBytes) {
            // A fixed 4:3 frame, whatever the size on screen.
            const previous = { width: element.clientWidth, height: element.clientHeight };
            const ratio = renderer.getPixelRatio();
            renderer.setPixelRatio(1);
            for (const [width, height] of [
              [1280, 960],
              [800, 600],
            ] as const) {
              renderer.setSize(width, height, false);
              camera.aspect = width / height;
              camera.updateProjectionMatrix();
              renderer.render(scene, camera);
              const webp = await toBlob(canvas, "image/webp", 0.9);
              const blob = webp?.type === "image/webp" ? webp : await toBlob(canvas, "image/png");
              if (blob && blob.size <= maxBytes) {
                renderer.setPixelRatio(ratio);
                renderer.setSize(previous.width, previous.height, false);
                resize();
                return blob;
              }
            }
            renderer.setPixelRatio(ratio);
            resize();
            return null;
          },
          resetView,
        });
      })
      .catch(() => {
        if (!disposed) callbacks.current.onFailure?.("load");
      });

    // Low video memory on a phone: the browser drops the context and the canvas goes black.
    const contextLost = () => callbacks.current.onFailure?.("context");
    canvas.addEventListener("webglcontextlost", contextLost);

    return () => {
      disposed = true;
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("keydown", keydown);
      observer.disconnect();
      controls.dispose();
      if (model) disposeTree(model);
      environment.dispose();
      pmrem.dispose();
      ktx2.dispose();
      renderer.dispose();
      // Give the video memory back now, not whenever the browser collects the canvas.
      renderer.forceContextLoss();
      canvas.remove();
      canvasRef.current = null;
    };
  }, [url, capturable]);

  return <div ref={host} className="model-canvas" />;
}
