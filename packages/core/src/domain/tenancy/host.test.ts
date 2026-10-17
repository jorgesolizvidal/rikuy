import { describe, expect, it } from "vitest";

import { classifyHost, normalizeHost } from "./host";

const local = { rootDomain: "localhost", adminHost: "app.localhost:3000" };
const prod = { rootDomain: "rikuy.app", adminHost: "app.rikuy.app" };

describe("normalizeHost", () => {
  it.each([
    ["Demo-Norte.Localhost:3000", "demo-norte.localhost", "3000"],
    ["turismo.example.bo.", "turismo.example.bo", null],
    ["  sur.example.test ", "sur.example.test", null],
    ["peña.example.bo", "xn--pea-8ma.example.bo", null],
  ])("normalizes %s", (raw, hostname, port) => {
    expect(normalizeHost(raw, { allowPort: true })).toEqual({ ok: true, host: { hostname, port } });
  });

  it.each([
    [null, "missing"],
    ["", "missing"],
    ["a.example.test, b.example.test", "malformed"],
    ["evil.example.test@good.example.test", "malformed"],
    ["good.example.test/evil", "malformed"],
    ["[::1]:3000", "malformed"],
    ["exa mple.test", "malformed"],
    ["under_score.example.test", "malformed"],
    ["-bad.example.test", "malformed"],
    [`${"a".repeat(64)}.example.test`, "malformed"],
  ])("rejects %s as %s", (raw, reason) => {
    expect(normalizeHost(raw, { allowPort: true })).toEqual({ ok: false, reason });
  });

  it("rejects ports when they are not allowed", () => {
    expect(normalizeHost("sur.example.test:8443", { allowPort: false })).toEqual({
      ok: false,
      reason: "port_not_allowed",
    });
  });
});

describe("classifyHost", () => {
  it("routes the admin host only on exact match (including port locally)", () => {
    expect(classifyHost("app.localhost:3000", local)).toEqual({ kind: "admin" });
    expect(classifyHost("APP.localhost:3000", local)).toEqual({ kind: "admin" });
    expect(classifyHost("app.localhost:4000", local)).toEqual({
      kind: "portal",
      hostname: "app.localhost",
    });
    expect(classifyHost("app.rikuy.app", prod)).toEqual({ kind: "admin" });
  });

  it("routes the platform apex to the product site", () => {
    expect(classifyHost("localhost:3000", local)).toEqual({ kind: "platform" });
    expect(classifyHost("rikuy.app", prod)).toEqual({ kind: "platform" });
  });

  it("treats every other well-formed host as a portal candidate", () => {
    expect(classifyHost("demo-norte.localhost:3000", local)).toEqual({
      kind: "portal",
      hostname: "demo-norte.localhost",
    });
    expect(classifyHost("turismo.municipio.gob.bo", prod)).toEqual({
      kind: "portal",
      hostname: "turismo.municipio.gob.bo",
    });
  });

  it("refuses ports in production", () => {
    expect(classifyHost("rikuy.app:8080", prod)).toEqual({
      kind: "invalid",
      reason: "port_not_allowed",
    });
  });

  it("fails loudly on a broken platform configuration", () => {
    expect(() =>
      classifyHost("x.example.test", { rootDomain: "bad domain", adminHost: "a" }),
    ).toThrow();
  });
});
