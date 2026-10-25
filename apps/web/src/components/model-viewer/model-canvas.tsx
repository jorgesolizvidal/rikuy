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
 * and, from P4, the portal's hotspot, so the poster looks like what visitors see.
 *
 * Color fidelity: sRGB output, Khronos PBR Neutral tone mapping (made to keep base colors)
 * and a neutral room environment; no extra colored lights.
 */
export interface ModelCanvasHandle {
  /** The current view as an image (WebP when the browser can encode it, else PNG). */
  capture(maxBytes: number): Promise<Blob | null>;
  resetView(): void;
}

export interface ModelCanvasProps {
  readonly url: string;
  /** Accessible name of the canvas (the page gives the text alternative next to it). */
  readonly label: string;
  readonly onReady?: ((handle: ModelCanvasHandle) => void) | undefined;
  /** WebGL or the file could not load: the page says so and keeps working. */
  readonly onFailure?: (() => void) | undefined;
}

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

export default function ModelCanvas({ url, label, onReady, onFailure }: ModelCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onFailure });
  useEffect(() => {
    callbacks.current = { onReady, onFailure };
  }, [onReady, onFailure]);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    } catch {
      callbacks.current.onFailure?.();
      return;
    }
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    const canvas = renderer.domElement;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", label);
    canvas.tabIndex = 0;
    element.appendChild(canvas);

    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = environment;
    const camera = new PerspectiveCamera(40, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.listenToKeyEvents(canvas);
    const home = { position: new Vector3(), target: new Vector3() };

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

    loader
      .loadAsync(url)
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
          resetView() {
            camera.position.copy(home.position);
            controls.target.copy(home.target);
            controls.update();
          },
        });
      })
      .catch(() => {
        if (!disposed) callbacks.current.onFailure?.();
      });

    canvas.addEventListener("webglcontextlost", () => callbacks.current.onFailure?.());

    return () => {
      disposed = true;
      observer.disconnect();
      controls.dispose();
      if (model) disposeTree(model);
      environment.dispose();
      pmrem.dispose();
      ktx2.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [url, label]);

  return <div ref={host} className="model-canvas" />;
}
