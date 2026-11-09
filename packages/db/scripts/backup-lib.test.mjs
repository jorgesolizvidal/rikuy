import { describe, expect, it } from "vitest";

import {
  countCopyRows,
  encodeObjectName,
  formatBytes,
  objectPath,
  parseManifest,
  quoteTable,
  rowMismatches,
  summarize,
} from "./backup-lib.mjs";

const DUMP = [
  "SET session_replication_role = replica;",
  'COPY "public"."tenants" ("id", "slug") FROM stdin;',
  "a1\tdemo-norte",
  "a2\tdemo-sur",
  "\\.",
  'COPY "auth"."users" ("id", "email") FROM stdin;',
  "\\.",
  'COPY "storage"."objects" ("id", "name") FROM stdin;',
  "o1\ta\\\\.b",
  "\\.",
  "SELECT pg_catalog.setval('x', 1, true);",
  "RESET ALL;",
].join("\n");

const SHA = "a".repeat(64);

function manifest(overrides = {}) {
  return {
    format: 1,
    createdAt: "2026-11-09T06:41:00.000Z",
    source: "linked",
    commit: null,
    tables: { "public.tenants": 2, "storage.objects": 1 },
    files: [
      {
        bucket: "media-originals",
        name: "t1/a1/1/original.png",
        size: 10,
        sha256: SHA,
        mimetype: "image/png",
        cacheControl: "max-age=3600",
      },
    ],
    ...overrides,
  };
}

describe("the data dump", () => {
  it("counts the rows of every table, empty ones included", () => {
    expect(countCopyRows(DUMP)).toEqual({
      "public.tenants": 2,
      "auth.users": 0,
      "storage.objects": 1,
    });
    expect(countCopyRows(DUMP.replaceAll("\n", "\r\n"))["public.tenants"]).toBe(2);
  });

  it("refuses a dump cut in the middle of a table or with a table twice", () => {
    expect(() => countCopyRows('COPY "public"."x" ("a") FROM stdin;\n1')).toThrow(/termina/u);
    expect(() => countCopyRows(`${DUMP}\n${DUMP}`)).toThrow(/repetida/u);
  });

  it("quotes tables for TRUNCATE, and refuses a name without schema", () => {
    expect(quoteTable("public.tenants")).toBe('"public"."tenants"');
    expect(quoteTable('odd."name')).toBe('"odd"."""name"');
    expect(() => quoteTable("tenants")).toThrow(/esquema/u);
  });
});

describe("the files", () => {
  it("keeps every object inside the backup's folder", () => {
    expect(objectPath("media-public", "t1/a1/2/960.webp")).toBe(
      "storage/media-public/t1/a1/2/960.webp",
    );
    for (const name of ["../etc/passwd", "a/../../b", "/abs", "a//b", "a\\b", "", "a/./b"]) {
      expect(() => objectPath("media-public", name), name).toThrow();
    }
    expect(() => objectPath("other", "a")).toThrow(/Bucket/u);
  });

  it("encodes each segment for the Storage API", () => {
    expect(encodeObjectName("t1/a b/ñ#1.png")).toBe("t1/a%20b/%C3%B1%231.png");
  });
});

describe("the manifest", () => {
  it("accepts a well-formed one and summarizes it with counts only", () => {
    const value = parseManifest(manifest());
    expect(summarize(value)).toEqual({
      tables: 2,
      rows: 3,
      files: 1,
      bytes: 10,
      byBucket: {
        "media-originals": { files: 1, bytes: 10 },
        "media-public": { files: 0, bytes: 0 },
      },
    });
  });

  it("refuses an unknown format, bad counts, unsafe or repeated files", () => {
    expect(() => parseManifest(manifest({ format: 2 }))).toThrow(/Formato/u);
    expect(() => parseManifest(manifest({ tables: { "public.tenants": -1 } }))).toThrow();
    const [file] = manifest().files;
    expect(() => parseManifest(manifest({ files: [{ ...file, name: "../x" }] }))).toThrow();
    expect(() => parseManifest(manifest({ files: [{ ...file, sha256: "x" }] }))).toThrow();
    expect(() => parseManifest(manifest({ files: [file, file] }))).toThrow(/repetido/u);
  });

  it("lists the tables whose restored rows differ", () => {
    expect(
      rowMismatches({ "public.tenants": 2, "auth.users": 3 }, { "public.tenants": 2 }),
    ).toEqual([{ table: "auth.users", expected: 3, actual: null }]);
    expect(formatBytes(57 * 1024 * 1024)).toBe("57,0 MB");
  });
});
