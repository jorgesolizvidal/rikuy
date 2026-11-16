import { describe, expect, it, vi } from "vitest";

import { emptyNoticeDocument, validateNoticeDocument } from "../../contracts/notice";
import type { OrganizationMembership } from "../../contracts/organization";
import { noticeInForce, noticesInForce } from "../../domain/notices/in-force";
import {
  describeNoticeValidity,
  localMinuteNow,
  noticePublicationIssues,
  noticeState,
} from "../../domain/notices/validity";
import { listNotices, publishNotice, retireNotice, saveNoticeDraft } from "./notices";
import type { NoticeListEntry, NoticeRepository } from "./ports";

const TZ = "America/La_Paz";
// 1 November 2026, 11:00 in La Paz (UTC−4).
const NOW = new Date("2026-11-01T15:00:00Z");

const member = (role: OrganizationMembership["role"]): OrganizationMembership =>
  ({ tenantId: "t1", role }) as OrganizationMembership;

const doc = (
  validity: { from: string | null; until: string | null },
  summary = "Corte de ruta.",
) => ({
  ...emptyNoticeDocument("Corte de ruta"),
  summary,
  validity,
});

function repository(overrides: Partial<NoticeRepository> = {}): NoticeRepository {
  return {
    list: vi.fn(async () => []),
    create: vi.fn(),
    find: vi.fn(),
    revisionDocument: vi.fn(),
    saveDraft: vi.fn(async () => ({ status: "saved" as const, revisionNo: 1, editCount: 2 })),
    publish: vi.fn(async () => ({ status: "published" as const, revisionNo: 1 })),
    retire: vi.fn(async () => ({ status: "retired" as const })),
    restore: vi.fn(),
    discardDraft: vi.fn(),
    places: vi.fn(async () => []),
    timezone: vi.fn(async () => TZ),
    ...overrides,
  } as NoticeRepository;
}

describe("a notice's document", () => {
  it("accepts a validity with or without «desde», and none yet in a draft", () => {
    expect(
      validateNoticeDocument(doc({ from: "2026-11-02T08:00", until: "2026-11-05T18:00" })).ok,
    ).toBe(true);
    expect(validateNoticeDocument(doc({ from: null, until: "2026-11-05T18:00" })).ok).toBe(true);
    expect(validateNoticeDocument(doc({ from: null, until: null })).ok).toBe(true);
  });

  it("refuses an end before its start, more than 90 days, a day that does not exist and other keys", () => {
    const issues = (input: unknown) => {
      const result = validateNoticeDocument(input);
      return result.ok ? [] : result.issues.map((issue) => `${issue.path}:${issue.code}`);
    };
    expect(issues(doc({ from: "2026-11-05T08:00", until: "2026-11-02T08:00" }))).toEqual([
      "validity.until:order",
    ]);
    expect(issues(doc({ from: "2026-11-01T08:00", until: "2027-02-01T08:00" }))).toEqual([
      "validity.until:too_long",
    ]);
    expect(issues(doc({ from: null, until: "2026-02-30T08:00" }))).toEqual([
      "validity.until:invalid",
    ]);
    expect(issues(doc({ from: null, until: "2026-11-02T24:00" }))).toEqual([
      "validity.until:invalid",
    ]);
    expect(issues({ ...doc({ from: null, until: null }), categoryId: null })).toHaveLength(1);
    expect(issues({ ...doc({ from: null, until: null }), placeId: "puente" })).toEqual([
      "placeId:invalid",
    ]);
  });
});

describe("a notice against the municipality's clock", () => {
  it("knows the local minute", () => {
    expect(localMinuteNow(NOW, TZ)).toBe("2026-11-01T11:00");
  });

  it("is programmed, in force or ended", () => {
    expect(noticeState({ from: "2026-11-01T12:00", until: "2026-11-03T12:00" }, NOW, TZ)).toBe(
      "scheduled",
    );
    expect(noticeState({ from: null, until: "2026-11-01T11:01" }, NOW, TZ)).toBe("active");
    expect(noticeState({ from: "2026-11-01T11:00", until: "2026-11-03T12:00" }, NOW, TZ)).toBe(
      "active",
    );
    expect(noticeState({ from: null, until: "2026-11-01T11:00" }, NOW, TZ)).toBe("expired");
    expect(noticeState({ from: null, until: null }, NOW, TZ)).toBe("incomplete");
  });

  it("asks for its text and an end still to come, at most 90 days from when it counts", () => {
    const codes = (d: ReturnType<typeof doc>) =>
      noticePublicationIssues(d, NOW, TZ).map((issue) => `${issue.path}:${issue.code}`);
    expect(codes(doc({ from: null, until: null }, ""))).toEqual([
      "summary:required",
      "validity.until:required",
    ]);
    expect(codes(doc({ from: null, until: "2026-11-01T10:59" }))).toEqual(["validity.until:past"]);
    expect(codes(doc({ from: null, until: "2027-01-31T11:00" }))).toEqual([
      "validity.until:too_long",
    ]);
    // 85 days from its start, 95 from now: it counts from «desde».
    expect(codes(doc({ from: "2026-11-11T11:00", until: "2027-02-04T11:00" }))).toEqual([]);
    expect(codes(doc({ from: null, until: "2026-11-03T18:00" }))).toEqual([]);
  });

  it("says its validity in words, the same with any ICU version", () => {
    expect(describeNoticeValidity({ from: null, until: "2026-11-03T18:00" })).toBe(
      "Hasta el 3 de noviembre de 2026, 18:00",
    );
    expect(describeNoticeValidity({ from: "2026-11-01T08:00", until: "2026-11-03T18:00" })).toBe(
      "Del 1 de noviembre de 2026, 08:00 al 3 de noviembre de 2026, 18:00",
    );
    expect(describeNoticeValidity({ from: null, until: null })).toBeNull();
  });

  it("in the browser: only what is in force, the one that ends sooner first", () => {
    const list = [
      { slug: "b", startsAt: null, endsAt: "2026-11-05T00:00:00Z" },
      { slug: "a", startsAt: null, endsAt: "2026-11-02T00:00:00Z" },
      { slug: "later", startsAt: "2026-11-01T16:00:00Z", endsAt: "2026-11-03T00:00:00Z" },
      { slug: "ended", startsAt: null, endsAt: "2026-11-01T15:00:00Z" },
    ];
    expect(noticesInForce(list, NOW).map((notice) => notice.slug)).toEqual(["a", "b"]);
    expect(noticeInForce({ startsAt: null, endsAt: "not a date" }, NOW)).toBe(false);
  });
});

describe("notices in the panel", () => {
  const entry = (overrides: Partial<NoticeListEntry>): NoticeListEntry => ({
    contentId: "c",
    slug: "s",
    title: "T",
    status: "published",
    published: { from: null, until: "2026-11-03T18:00" },
    validity: { from: null, until: "2026-11-03T18:00" },
    updatedAt: "2026-11-01T10:00:00Z",
    publishedAt: "2026-11-01T10:00:00Z",
    ...overrides,
  });

  it("lists in force first, then programmed, drafts, ended and retired", async () => {
    const repo = repository({
      list: vi.fn(async () => [
        entry({ slug: "retired", status: "retired", published: null }),
        entry({ slug: "ended", published: { from: null, until: "2026-10-31T18:00" } }),
        entry({ slug: "draft", status: "draft", published: null }),
        entry({ slug: "soon", published: { from: "2026-11-02T08:00", until: "2026-11-04T18:00" } }),
        entry({ slug: "now", status: "changed" }),
      ]),
    });
    const rows = await listNotices(member("analyst"), NOW, repo);
    expect(rows.map((row) => `${row.slug}:${row.state}`)).toEqual([
      "now:active",
      "soon:scheduled",
      "draft:draft",
      "ended:expired",
      "retired:retired",
    ]);
    expect(rows[0]?.changed).toBe(true);
  });

  it("an editor saves a draft but does not publish; an analyst does neither", async () => {
    const repo = repository();
    const draft = doc({ from: null, until: "2026-11-03T18:00" });
    expect((await saveNoticeDraft(member("editor"), "c", draft, 1, repo)).status).toBe("saved");
    expect((await saveNoticeDraft(member("analyst"), "c", draft, 1, repo)).status).toBe(
      "forbidden",
    );
    expect((await publishNotice(member("editor"), "c", draft, 1, NOW, repo)).status).toBe(
      "forbidden",
    );
    expect((await retireNotice(member("editor"), "c", repo)).status).toBe("forbidden");
  });

  it("refuses to publish an ended notice before asking the database", async () => {
    const repo = repository();
    const result = await publishNotice(
      member("owner"),
      "c",
      doc({ from: null, until: "2026-10-31T18:00" }),
      1,
      NOW,
      repo,
    );
    expect(result).toEqual({
      status: "invalid",
      issues: [{ path: "validity.until", code: "past" }],
    });
    expect(repo.saveDraft).not.toHaveBeenCalled();
  });

  it("publishes a notice in force; a place of another municipality comes back as such", async () => {
    const repo = repository();
    expect(
      (
        await publishNotice(
          member("owner"),
          "c",
          doc({ from: null, until: "2026-11-03T18:00" }),
          1,
          NOW,
          repo,
        )
      ).status,
    ).toBe("published");
    expect(repo.publish).toHaveBeenCalledWith("t1", "c", 2);
    const refused = repository({
      saveDraft: vi.fn(async () => ({ status: "invalid" as const, reason: "place" as const })),
    });
    expect(
      await saveNoticeDraft(member("editor"), "c", doc({ from: null, until: null }), 1, refused),
    ).toEqual({ status: "invalid", issues: [{ path: "placeId", code: "place" }] });
  });

  it("when the database's clock says it ended, the editor hears why", async () => {
    const repo = repository({
      publish: vi.fn(async () => ({ status: "invalid" as const, reason: "validity" as const })),
    });
    expect(
      await publishNotice(
        member("admin"),
        "c",
        doc({ from: null, until: "2026-11-03T18:00" }),
        1,
        NOW,
        repo,
      ),
    ).toEqual({ status: "invalid", issues: [{ path: "validity.until", code: "past" }] });
  });
});
