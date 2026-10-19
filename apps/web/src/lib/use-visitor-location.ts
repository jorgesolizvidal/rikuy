"use client";

import { useSyncExternalStore } from "react";

import {
  createLocationStore,
  SERVER_SNAPSHOT,
  type LocationSnapshot,
  type LocationStore,
} from "./visitor-location";

const REMEMBER_KEY = "rikuy:location";

let store: LocationStore | null = null;

/** One store per page: every component shares the same reading and the same watch. */
function browserStore(): LocationStore {
  store ??= createLocationStore({
    secure: window.isSecureContext,
    geolocation: "geolocation" in navigator ? navigator.geolocation : undefined,
    queryPermission:
      typeof navigator.permissions?.query === "function"
        ? () => navigator.permissions.query({ name: "geolocation" })
        : undefined,
    isHidden: () => document.visibilityState === "hidden",
    onVisibilityChange: (listener) => document.addEventListener("visibilitychange", listener),
    remember: {
      get() {
        try {
          return window.sessionStorage.getItem(REMEMBER_KEY) === "on";
        } catch {
          return false;
        }
      },
      set(on) {
        try {
          if (on) window.sessionStorage.setItem(REMEMBER_KEY, "on");
          else window.sessionStorage.removeItem(REMEMBER_KEY);
        } catch {
          // Storage blocked (private mode): the visitor presses the button again.
        }
      },
    },
    now: () => Date.now(),
  });
  return store;
}

export function useVisitorLocation(): LocationSnapshot & {
  readonly start: () => void;
  readonly stop: () => void;
} {
  const snapshot = useSyncExternalStore(
    (listener) => browserStore().subscribe(listener),
    () => browserStore().getSnapshot(),
    () => SERVER_SNAPSHOT,
  );
  return {
    ...snapshot,
    start: () => browserStore().start(),
    stop: () => browserStore().stop(),
  };
}
