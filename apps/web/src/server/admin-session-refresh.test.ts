import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it } from "vitest";

import { createAdminSessionRefresher } from "./admin-session-refresh";

describe("admin session refresher", () => {
  it("does not call the identity provider for anonymous requests", async () => {
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      calls += 1;
      return original(...args);
    };
    try {
      const refresh = createAdminSessionRefresher({
        url: "http://127.0.0.1:9",
        publishableKey: "sb_publishable_test",
        secureCookies: true,
      });
      const request = new NextRequest("http://app.localhost:3000/", {
        headers: { host: "app.localhost:3000" },
      });
      const response = await refresh(request, () => NextResponse.next());
      expect(response.status).toBe(200);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});
