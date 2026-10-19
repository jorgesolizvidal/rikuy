import { describe, expect, it } from "vitest";

import { createLocationStore, locationMessage, type LocationEnvironment } from "./visitor-location";

const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;

/** A scripted device: the test decides what the "GPS" and the "browser" answer. */
function device(options: { secure?: boolean; permission?: PermissionState | null } = {}) {
  let success: PositionCallback | null = null;
  let failure: PositionErrorCallback | null = null;
  let watching = 0;
  let hidden = false;
  let remembered = false;
  let visibility: (() => void) | null = null;
  const permissionListeners: (() => void)[] = [];
  const permission = {
    state: options.permission ?? "prompt",
    addEventListener: (_: string, listener: () => void) => permissionListeners.push(listener),
  } as unknown as PermissionStatus;

  const geolocation = {
    watchPosition(onSuccess: PositionCallback, onError?: PositionErrorCallback | null) {
      success = onSuccess;
      failure = onError ?? null;
      watching += 1;
      return watching;
    },
    clearWatch() {
      success = null;
      failure = null;
    },
    getCurrentPosition() {},
  } as unknown as Geolocation;

  const env: LocationEnvironment = {
    secure: options.secure ?? true,
    geolocation,
    queryPermission: options.permission === null ? undefined : () => Promise.resolve(permission),
    isHidden: () => hidden,
    onVisibilityChange: (listener) => {
      visibility = listener;
    },
    remember: {
      get: () => remembered,
      set: (on) => {
        remembered = on;
      },
    },
    now: () => 0,
  };

  return {
    env,
    get watching() {
      return success !== null;
    },
    get watchCalls() {
      return watching;
    },
    get remembered() {
      return remembered;
    },
    remember() {
      remembered = true;
    },
    position(lat: number, lng: number, accuracy = 12) {
      success?.({ coords: { latitude: lat, longitude: lng, accuracy } } as GeolocationPosition);
    },
    fail(code: number) {
      failure?.({
        code,
        PERMISSION_DENIED,
        POSITION_UNAVAILABLE,
        TIMEOUT: 3,
      } as GeolocationPositionError);
    },
    hide(value: boolean) {
      hidden = value;
      visibility?.();
    },
    revoke() {
      (permission as { state: PermissionState }).state = "denied";
      for (const listener of permissionListeners) listener();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("visitor location (RC-06)", () => {
  it("asks for nothing until the visitor presses the button", async () => {
    const phone = device();
    const store = createLocationStore(phone.env);
    store.subscribe(() => {});
    await settle();
    expect(phone.watchCalls).toBe(0);
    expect(store.getSnapshot()).toMatchObject({ status: "off", permission: "prompt" });
  });

  it("granted: follows the position and skips readings that change nothing", () => {
    const phone = device();
    const store = createLocationStore(phone.env);
    let renders = 0;
    store.subscribe(() => (renders += 1));
    store.start();
    expect(store.getSnapshot().status).toBe("starting");
    phone.position(-17.3895, -66.1568);
    expect(store.getSnapshot()).toMatchObject({
      status: "on",
      permission: "granted",
      fix: { lat: -17.3895, lng: -66.1568, accuracy: 12 },
    });
    const before = renders;
    phone.position(-17.38951, -66.1568); // ~1 m
    expect(renders).toBe(before);
    phone.position(-17.3885, -66.1568); // ~111 m
    expect(store.getSnapshot().fix?.lat).toBe(-17.3885);
  });

  it("denied: says so, stops watching and forgets the choice", () => {
    const phone = device();
    const store = createLocationStore(phone.env);
    store.subscribe(() => {});
    store.start();
    phone.fail(PERMISSION_DENIED);
    expect(store.getSnapshot()).toMatchObject({ status: "denied", fix: null });
    expect(phone.watching).toBe(false);
    expect(phone.remembered).toBe(false);
    expect(locationMessage("denied")).toMatch(/todo funciona igual/u);
  });

  it("unknown (no Permissions API): asks only on the button and keeps waiting for a signal", async () => {
    const phone = device({ permission: null });
    const store = createLocationStore(phone.env);
    store.subscribe(() => {});
    phone.remember(); // even if turned on earlier, an unknown permission is never assumed
    await settle();
    expect(phone.watchCalls).toBe(0);
    expect(store.getSnapshot().permission).toBe("unknown");
    store.start();
    phone.fail(POSITION_UNAVAILABLE);
    expect(store.getSnapshot().status).toBe("unavailable");
    expect(phone.watching).toBe(true);
    phone.position(-17.39, -66.15);
    expect(store.getSnapshot().status).toBe("on");
  });

  it("resumes on the next page only if it was turned on and is still granted", async () => {
    const phone = device({ permission: "granted" });
    phone.remember();
    const store = createLocationStore(phone.env);
    store.subscribe(() => {});
    await settle();
    expect(phone.watching).toBe(true);

    const other = device({ permission: "granted" });
    const fresh = createLocationStore(other.env);
    fresh.subscribe(() => {});
    await settle();
    expect(other.watchCalls).toBe(0);
  });

  it("pauses while the tab is hidden and resumes when it is visible", () => {
    const phone = device();
    const store = createLocationStore(phone.env);
    store.subscribe(() => {});
    store.start();
    phone.position(-17.39, -66.15);
    phone.hide(true);
    expect(store.getSnapshot().status).toBe("paused");
    expect(phone.watching).toBe(false);
    phone.hide(false);
    expect(phone.watching).toBe(true);
    expect(store.getSnapshot().status).toBe("on");
  });

  it("stops when the visitor turns it off or revokes the permission", async () => {
    const phone = device({ permission: "prompt" });
    const store = createLocationStore(phone.env);
    store.subscribe(() => {});
    await settle();
    store.start();
    phone.position(-17.39, -66.15);
    store.stop();
    expect(store.getSnapshot()).toMatchObject({ status: "off", fix: null });
    expect(phone.watching).toBe(false);
    store.start();
    phone.position(-17.39, -66.15);
    phone.revoke();
    expect(store.getSnapshot()).toMatchObject({ status: "denied", fix: null });
    expect(phone.watching).toBe(false);
  });

  it("does not offer location on plain http", () => {
    const phone = device({ secure: false });
    const store = createLocationStore(phone.env);
    store.subscribe(() => {});
    store.start();
    expect(store.getSnapshot().status).toBe("insecure");
    expect(phone.watchCalls).toBe(0);
  });

  it("survives a browser whose Permissions API throws for geolocation", () => {
    const phone = device();
    const store = createLocationStore({
      ...phone.env,
      queryPermission: () => {
        throw new TypeError("geolocation is not a valid permission name");
      },
    });
    expect(() => store.subscribe(() => {})).not.toThrow();
    store.start();
    phone.position(-17.39, -66.15);
    expect(store.getSnapshot()).toMatchObject({ status: "on", permission: "granted" });
  });
});
