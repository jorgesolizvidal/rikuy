import { describe, expect, it } from "vitest";

import {
  EnvValidationError,
  isReadablePostgresUrl,
  parseAiEnv,
  parseJobRunnerEnv,
  parseMailEnv,
  parsePlatformEnv,
  parsePublicEnv,
  parseServerEnv,
} from "./env";

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

  it("platform parsing does not require the secret key", () => {
    const { SUPABASE_SECRET_KEY: _secret, ...withoutSecret } = valid;
    expect(parsePlatformEnv(withoutSecret)).not.toHaveProperty("SUPABASE_SECRET_KEY");
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

  it("validates the job runner settings without echoing them", () => {
    const runner = {
      WORKER_DATABASE_URL: "postgresql://rikuy_worker.ref:pw@pooler.example.test:6543/postgres",
      JOB_RUNNER_SECRET: "x".repeat(40),
      WORKER_DATABASE_ROLE: "",
    };
    expect(parseJobRunnerEnv(runner)).toEqual({
      WORKER_DATABASE_URL: runner.WORKER_DATABASE_URL,
      JOB_RUNNER_SECRET: runner.JOB_RUNNER_SECRET,
    });
    try {
      parseJobRunnerEnv({ ...runner, JOB_RUNNER_SECRET: "short-secret-value" });
      expect.unreachable();
    } catch (error) {
      expect((error as EnvValidationError).invalidKeys).toEqual(["JOB_RUNNER_SECRET"]);
      expect(String((error as Error).message)).not.toContain("short-secret-value");
    }
    expect(() => parseJobRunnerEnv({ ...runner, WORKER_DATABASE_URL: "https://x" })).toThrow(
      EnvValidationError,
    );
  });

  it("takes the SMTP settings all or nothing, without echoing the password", () => {
    expect(parseMailEnv({})).toBeNull();
    const gmail = {
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: "465",
      SMTP_USER: "avisos@example.test",
      SMTP_PASSWORD: "abcd efgh ijkl mnop",
      MAIL_FROM: "Rikuy <avisos@example.test>",
    };
    expect(parseMailEnv(gmail)).toEqual({ ...gmail, SMTP_PORT: 465 });
    expect(
      parseMailEnv({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "54325", MAIL_FROM: "a@b.test" }),
    ).toEqual({ SMTP_HOST: "127.0.0.1", SMTP_PORT: 54325, MAIL_FROM: "a@b.test" });
    try {
      parseMailEnv({ ...gmail, SMTP_PASSWORD: "" });
      expect.unreachable();
    } catch (error) {
      expect((error as EnvValidationError).invalidKeys).toEqual(["SMTP_PASSWORD"]);
    }
    try {
      parseMailEnv({ SMTP_PASSWORD: gmail.SMTP_PASSWORD });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("abcd");
    }
    expect(() => parseMailEnv({ ...gmail, MAIL_FROM: "Rikuy <x@y.test>\nBcc: z@y.test" })).toThrow(
      EnvValidationError,
    );
  });

  it("reads the AI gateway's settings, all or nothing, never simulated in production", () => {
    expect(parseAiEnv({})).toBeNull();
    const groq = {
      AI_DATABASE_URL:
        "postgresql://rikuy_ai.ref:pw@aws-0-sa-east-1.pooler.supabase.com:6543/postgres",
      // Not a key: low entropy on purpose, so no secret scanner mistakes it for one.
      GROQ_API_KEY: `gsk_${"x".repeat(32)}`,
    };
    expect(parseAiEnv(groq)).toEqual({
      ...groq,
      AI_PROVIDER: "groq",
      AI_MODEL: "openai/gpt-oss-120b",
    });
    expect(
      parseAiEnv({
        AI_DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/rikuy",
        AI_DATABASE_ROLE: "rikuy_ai",
        AI_PROVIDER: "simulated",
      }),
    ).toMatchObject({ AI_PROVIDER: "simulated", AI_DATABASE_ROLE: "rikuy_ai" });
    const invalid = (source: Record<string, string>) => {
      try {
        parseAiEnv(source);
        return [];
      } catch (error) {
        expect(String((error as Error).message)).not.toContain("gsk_");
        return (error as EnvValidationError).invalidKeys;
      }
    };
    expect(invalid({ GROQ_API_KEY: groq.GROQ_API_KEY })).toEqual(["AI_DATABASE_URL"]);
    expect(invalid({ AI_DATABASE_URL: groq.AI_DATABASE_URL })).toEqual(["GROQ_API_KEY"]);
    expect(invalid({ ...groq, AI_MODEL: "gpt oss" })).toEqual(["AI_MODEL"]);
    expect(
      invalid({
        AI_DATABASE_URL: groq.AI_DATABASE_URL,
        AI_PROVIDER: "simulated",
        VERCEL_ENV: "production",
      }),
    ).toEqual(["AI_PROVIDER"]);
  });

  it.each(["#", "/", "?", "%"])(
    "names a connection string whose password has an unescaped %s, without echoing it",
    (symbol) => {
      const url = `postgresql://rikuy_ai.ref:pw${symbol}secreto@pooler.example.test:6543/postgres`;
      try {
        parseAiEnv({ AI_DATABASE_URL: url, GROQ_API_KEY: `gsk_${"x".repeat(32)}` });
        expect.unreachable();
      } catch (error) {
        expect((error as EnvValidationError).invalidKeys).toEqual(["AI_DATABASE_URL"]);
        expect(String((error as Error).message)).not.toContain("secreto");
      }
      expect(() =>
        parseJobRunnerEnv({
          WORKER_DATABASE_URL: url.replace("rikuy_ai", "rikuy_worker"),
          JOB_RUNNER_SECRET: "x".repeat(40),
        }),
      ).toThrow(EnvValidationError);
    },
  );

  it("accepts a password with the same symbols percent-encoded", () => {
    const url = "postgresql://rikuy_ai.ref:pw%23%2F%3F%25@pooler.example.test:6543/postgres";
    expect(isReadablePostgresUrl(url)).toBe(true);
    expect(
      parseAiEnv({ AI_DATABASE_URL: url, GROQ_API_KEY: `gsk_${"x".repeat(32)}` }),
    ).toMatchObject({ AI_DATABASE_URL: url });
    expect(isReadablePostgresUrl("postgresql://postgres@127.0.0.1:55432/rikuy")).toBe(true);
  });
});
