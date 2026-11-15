import { describe, expect, it } from "vitest";

import { nextSuggestedStop, readScannedCode } from "./scan";
import type { PassportStamp } from "./stamps";

const ORIGIN = "https://rikuy-ucurena.vercel.app";
const CODE = "CUrgLsP5oPvsGiJwm0epGg";

describe("a scanned QR (C3 · Paso 5)", () => {
  it("a stamp of this portal opens its page (with ?qr, a trailing slash, spaces)", () => {
    expect(readScannedCode(`${ORIGIN}/sello/${CODE}`, ORIGIN)).toEqual({
      kind: "stamp",
      path: `/sello/${CODE}`,
    });
    expect(readScannedCode(`  ${ORIGIN}/sello/${CODE}/?qr=1 `, ORIGIN)).toEqual({
      kind: "stamp",
      path: `/sello/${CODE}`,
    });
  });

  it("another site, another portal, another page or a bad code is never opened", () => {
    for (const raw of [
      `https://evil.example/sello/${CODE}`,
      `https://rikuy-demo-sur.vercel.app/sello/${CODE}`,
      `${ORIGIN}/destinos/museo`,
      `${ORIGIN}/sello/corto`,
      `${ORIGIN}/sello/${CODE}/extra`,
      `javascript:alert(1)`,
    ]) {
      expect(readScannedCode(raw, ORIGIN).kind, raw).toBe("other");
    }
    expect(readScannedCode("Hola, esto no es un enlace", ORIGIN)).toEqual({ kind: "text" });
  });
});

describe("the next suggested stop", () => {
  const stamp = (placeId: string): PassportStamp => ({
    placeId,
    slug: placeId,
    title: placeId,
    at: 1,
    located: false,
    signature: "x".repeat(43),
  });

  it("the first stop without a stamp, in the circuit's order; none when complete", () => {
    expect(nextSuggestedStop(["a", "b", "c"], {})).toBe(0);
    expect(nextSuggestedStop(["a", "b", "c"], { a: stamp("a"), c: stamp("c") })).toBe(1);
    expect(nextSuggestedStop(["a", "b"], { a: stamp("a"), b: stamp("b") })).toBeNull();
    expect(nextSuggestedStop([null, "b"], { b: stamp("b") })).toBe(0);
  });
});
