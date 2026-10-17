import { describe, expect, it } from "vitest";

import { EnvValidationError, parsePublicEnv, parseServerEnv } from "./env";

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
  SUPABASE_SECRET_KEY: "sb_secret_super_private_value",
  PLATFORM_ROOT_DOMAIN: "localhost",
  PLATFORM_ADMIN_HOST: "app.localhost:3000",
};

describe("environment contract", () => {
  it("accepts a complete server environment", () => {
    expect(parseServerEnv(valid)).toMatchObject({ PLATFORM_ROOT_DOMAIN: "localhost" });
  });

  it("public parsing ignores server-only variables", () => {
    const env = parsePublicEnv(valid);
    expect(Object.keys(env).sort()).toEqual([
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
    ]);
  });

  it("reports missing variables by name", () => {
    const { SUPABASE_SECRET_KEY: _omitted, ...rest } = valid;
    try {
      parseServerEnv(rest);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).invalidKeys).toEqual(["SUPABASE_SECRET_KEY"]);
    }
  });

  it("never echoes values in the error message", () => {
    const leaky = { ...valid, NEXT_PUBLIC_SUPABASE_URL: "not a url with sb_secret_inside" };
    expect(() => parseServerEnv(leaky)).toThrowError(EnvValidationError);
    try {
      parseServerEnv(leaky);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("sb_secret");
    }
  });

  it("rejects hosts with uppercase or schemes", () => {
    expect(() => parseServerEnv({ ...valid, PLATFORM_ADMIN_HOST: "https://App.example" })).toThrow(
      EnvValidationError,
    );
  });
});
