import type { AiRequestInput } from "@rikuy/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Not a key: low entropy on purpose, so no secret scanner mistakes it for one.
const KEY = `gsk_${"x".repeat(32)}`;
const URL_OK = "postgresql://rikuy_ai.ref:pw@pooler.example.test:6543/postgres";
const REQUEST: AiRequestInput = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  profile: "probe",
  messages: [{ role: "user", content: "¿Estás disponible?" }],
};

function useEnv(env: Record<string, string>) {
  Object.assign(process.env, env);
}

afterEach(() => {
  for (const key of ["AI_DATABASE_URL", "GROQ_API_KEY", "AI_PROVIDER", "AI_DATABASE_ROLE"])
    delete process.env[key];
  vi.doUnmock("@rikuy/db/ai");
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("AI gateway", () => {
  it("is off without its settings", async () => {
    const gateway = await import("./ai-gateway");
    expect(gateway.aiGatewayStatus()).toEqual({
      configured: false,
      invalidKeys: [],
      provider: null,
      model: null,
    });
    expect(await gateway.runAi(REQUEST)).toEqual({ outcome: "not_configured", requestId: null });
  });

  it("names the variable when a password symbol makes the address unreadable", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    useEnv({
      AI_DATABASE_URL: "postgresql://rikuy_ai.ref:pw#secreto@pooler.example.test:6543/postgres",
      GROQ_API_KEY: KEY,
    });
    const gateway = await import("./ai-gateway");
    expect(gateway.aiGatewayStatus()).toMatchObject({
      configured: false,
      invalidKeys: ["AI_DATABASE_URL"],
    });
    expect(await gateway.runAi(REQUEST)).toEqual({ outcome: "not_configured", requestId: null });
    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain('"ai.misconfigured"');
    expect(logged).not.toContain("secreto");
    expect(logged).not.toContain(KEY);
  });

  it("answers «no AI» instead of throwing when the connection cannot be built", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.doMock("@rikuy/db/ai", async (original) => ({
      ...(await original<typeof import("@rikuy/db/ai")>()),
      createPostgresAiLedger: () => {
        throw new TypeError("Invalid URL");
      },
    }));
    useEnv({ AI_DATABASE_URL: URL_OK, GROQ_API_KEY: KEY });
    const gateway = await import("./ai-gateway");
    expect(gateway.aiGatewayStatus()).toMatchObject({ configured: true, invalidKeys: [] });
    expect(await gateway.runAi(REQUEST)).toEqual({ outcome: "not_configured", requestId: null });
    const line = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({ level: "warn", event: "ai.setup_failed", error: "TypeError" });
  });
});
