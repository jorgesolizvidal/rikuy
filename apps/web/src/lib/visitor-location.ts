import { isMeaningfulFix, type PositionFix } from "@rikuy/core/geo";

/**
 * The visitor's position, in the browser only (ADR-021, RC-06).
 *
 * - Asked for only after the visitor presses «Usar mi ubicación» (`start`), never on load.
 * - Followed with `watchPosition` while the page is visible; hiding the tab stops the
 *   device's location (battery) and showing it again resumes.
 * - The position stays in memory: it is never sent to our server, never stored. The only
 *   thing remembered (for this tab, in sessionStorage) is that the visitor turned it on,
 *   so the next page resumes without asking again — and only if the browser says the
 *   permission is already granted.
 */

export type LocationStatus =
  /** Not asked (or turned off). */
  | "off"
  /** Asked; waiting for the first reading (the browser may be showing its prompt). */
  | "starting"
  /** Following the position. */
  | "on"
  /** The tab is hidden; resumes when it is visible again. */
  | "paused"
  /** The visitor (or the browser settings) refused. */
  | "denied"
  /** The device could not tell where it is (no GPS signal, location services off). */
  | "unavailable"
  /** Plain http: browsers only give positions to secure pages. */
  | "insecure"
  /** No geolocation in this browser. */
  | "unsupported";

/** What the browser says before asking ("unknown" when it does not say). */
export type PermissionHint = "granted" | "denied" | "prompt" | "unknown";

export interface LocationSnapshot {
  readonly status: LocationStatus;
  readonly fix: PositionFix | null;
  readonly permission: PermissionHint;
}

export interface LocationEnvironment {
  readonly secure: boolean;
  readonly geolocation: Geolocation | undefined;
  /** Permissions API, when available. */
  queryPermission?: (() => Promise<PermissionStatus>) | undefined;
  readonly isHidden: () => boolean;
  readonly onVisibilityChange: (listener: () => void) => void;
  readonly remember: { get(): boolean; set(on: boolean): void };
  readonly now: () => number;
}

export interface LocationStore {
  getSnapshot(): LocationSnapshot;
  subscribe(listener: () => void): () => void;
  /** The visitor pressed «Usar mi ubicación». */
  start(): void;
  /** The visitor pressed «Dejar de usar mi ubicación». */
  stop(): void;
}

export const SERVER_SNAPSHOT: LocationSnapshot = {
  status: "off",
  fix: null,
  permission: "unknown",
};

const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 5_000,
  timeout: 30_000,
};

export function createLocationStore(env: LocationEnvironment): LocationStore {
  let snapshot: LocationSnapshot = {
    status: !env.secure ? "insecure" : env.geolocation ? "off" : "unsupported",
    fix: null,
    permission: "unknown",
  };
  const listeners = new Set<() => void>();
  let watchId: number | null = null;
  /** The visitor wants their location on (survives hiding the tab). */
  let wanted = false;
  let initialized = false;

  const set = (patch: Partial<LocationSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };

  const available = () => snapshot.status !== "insecure" && snapshot.status !== "unsupported";

  const clearWatch = () => {
    if (watchId !== null) env.geolocation?.clearWatch(watchId);
    watchId = null;
  };

  const watch = () => {
    if (!env.geolocation || watchId !== null) return;
    watchId = env.geolocation.watchPosition(
      (position) => {
        const fix: PositionFix = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          at: env.now(),
        };
        if (snapshot.status !== "on" || isMeaningfulFix(snapshot.fix, fix)) {
          set({ status: "on", fix, permission: "granted" });
        }
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          wanted = false;
          env.remember.set(false);
          clearWatch();
          set({ status: "denied", fix: null, permission: "denied" });
        } else if (snapshot.fix === null) {
          // No reading yet: say so, and keep watching (the signal may come back).
          set({ status: "unavailable" });
        }
      },
      WATCH_OPTIONS,
    );
  };

  const init = () => {
    if (initialized || !available()) return;
    initialized = true;
    env.onVisibilityChange(() => {
      if (!wanted) return;
      if (env.isHidden()) {
        clearWatch();
        set({ status: "paused" });
      } else {
        set({ status: snapshot.fix ? "on" : "starting" });
        watch();
      }
    });
    let query: Promise<PermissionStatus> | undefined;
    try {
      query = env.queryPermission?.();
    } catch {
      query = undefined;
    }
    void query
      ?.then((permission) => {
        const update = () => {
          const state = permission.state as PermissionHint;
          set({ permission: state });
          if (state === "denied" && wanted) {
            wanted = false;
            env.remember.set(false);
            clearWatch();
            set({ status: "denied", fix: null });
          }
        };
        update();
        permission.addEventListener("change", update);
        // Turned on earlier in this tab and still allowed: resume without a prompt.
        if (permission.state === "granted" && env.remember.get() && !wanted) start();
      })
      .catch(() => {
        // Permissions API without "geolocation" (older Safari): stays "unknown".
      });
  };

  function start() {
    if (!available()) return;
    wanted = true;
    env.remember.set(true);
    set({ status: env.isHidden() ? "paused" : "starting" });
    if (!env.isHidden()) watch();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      init();
      return () => listeners.delete(listener);
    },
    start,
    stop() {
      wanted = false;
      env.remember.set(false);
      clearWatch();
      if (available()) set({ status: "off", fix: null });
    },
  };
}

/** Short Spanish text for the state, or null when nothing needs saying. */
export function locationMessage(status: LocationStatus): string | null {
  switch (status) {
    case "starting":
      return "Buscando tu ubicación…";
    case "paused":
      return "Ubicación en pausa mientras la página no está a la vista.";
    case "denied":
      return "No tenemos permiso para usar tu ubicación. Puedes activarlo en los ajustes del navegador; todo funciona igual sin ella.";
    case "unavailable":
      return "No pudimos saber dónde estás. Revisa que la ubicación del teléfono esté activada.";
    case "insecure":
      return "La ubicación solo funciona cuando el portal se abre con https.";
    case "unsupported":
      return "Este navegador no ofrece la ubicación.";
    default:
      return null;
  }
}
