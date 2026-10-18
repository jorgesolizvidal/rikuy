import { readFileSync } from "node:fs";

import { validatePresentation } from "@rikuy/core";
import { describe, expect, it } from "vitest";

// The seed writes presentations straight into the table (no RPC), so check here that they
// satisfy the same contract the admin enforces, contrast included.
const seed = readFileSync(new URL("../../../supabase/seed.sql", import.meta.url), "utf8");
const presentations = [...seed.matchAll(/'(\{"identity":[\s\S]*?\}\})'/g)].map((match) =>
  JSON.parse(match[1] ?? "null"),
);

describe("seed presentations", () => {
  it("contains one published brand per demo municipality", () => {
    expect(presentations).toHaveLength(2);
  });

  it.each(presentations.map((p, i) => [i, p]))("brand %i passes full validation", (_i, p) => {
    expect(validatePresentation(p)).toMatchObject({ ok: true });
  });
});
