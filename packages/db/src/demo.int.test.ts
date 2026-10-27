/**
 * Commercial demos and invitation emails against a REAL local Supabase stack (ADR-034):
 * the sample content goes through the panel's own use cases (signed uploads, derivatives,
 * publication, quotas), visitors see it on a portal that knows it is a demo, the sample
 * tour is published, and an invitation email reaches Mailpit through SMTP.
 */
import { randomUUID } from "node:crypto";

import {
  buildSampleTour,
  drainJobs,
  loadSampleContent,
  loadSampleContentStatus,
  SAMPLE_DESTINATIONS,
  SAMPLE_EVENTS,
  type OrganizationMembership,
} from "@rikuy/core";
import { createMembershipInvitationMailProcessor } from "@rikuy/worker";
import postgres from "postgres";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContentRepository } from "./content";
import { env, mailpit, signIn, stackAvailable, USERS } from "./integration/local-stack";
import { createPostgresJobLedger } from "./job-ledger";
import {
  createSharpImageProcessor,
  createMediaRepository,
  createSupabaseMediaAdmin,
} from "./media";
import { createPanoramaRepository } from "./panoramas";
import { createMemberRepository } from "./platform";
import { createSharpSampleImageRenderer } from "./sample-images";
import { createSmtpMailer } from "./smtp-mailer";
import { createSupabaseTenantDirectory } from "./tenant-directory";
import { createTourRepository } from "./tours";

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const OWNER_SUR = "5eed0000-0000-4000-8000-000000000002";
const SMTP_PORT = Number(process.env.MAILPIT_SMTP_PORT ?? 54325);

describe.runIf(stackAvailable)("commercial demo against local Supabase", () => {
  const db = postgres(DB_URL, { max: 1, prepare: false, onnotice: () => undefined });
  const tenantId = randomUUID();
  const slug = `demo-${tenantId.slice(0, 8)}`;
  const hostname = `${slug}.localhost`;
  let owner: Awaited<ReturnType<typeof signIn>>;
  let membership: OrganizationMembership;

  beforeAll(async () => {
    if (env.secretKey === "") throw new Error("SUPABASE_SECRET_KEY is required");
    // A demo provisioned by the operator, already online, with the Demo Sur owner as owner.
    await db.begin(async (sql) => {
      await sql`
        insert into public.tenants (id, slug, display_name, status, default_locale, timezone, is_demo)
        values (${tenantId}, ${slug}, 'Demo Valle Integración', 'provisioning', 'es', 'America/La_Paz', true)
      `;
      const [domain] = await sql`
        insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at)
        values (${tenantId}, ${hostname}, 'platform', 'active', now()) returning id
      `;
      await sql`update public.tenants set canonical_domain_id = ${domain?.id ?? null} where id = ${tenantId}`;
      await sql`
        insert into public.memberships (tenant_id, user_id, role, status, accepted_at)
        values (${tenantId}, ${OWNER_SUR}, 'owner', 'active', now())
      `;
    });
    await db`update public.tenants set status = 'active' where id = ${tenantId}`;
    owner = await signIn(USERS.ownerSur);
    const found = (await owner.reader.listActiveMemberships(owner.actor.userId)).find(
      (entry) => entry.tenantId === tenantId,
    );
    if (!found) throw new Error("the demo membership is not visible");
    membership = found;
  });

  afterAll(async () => {
    // Leave the stack as other suites expect it: the demo goes offline.
    await db`update public.tenants set status = 'suspended' where id = ${tenantId}`;
    await db.end({ timeout: 5 });
  });

  function deps() {
    const content = createContentRepository(owner.client);
    return {
      content,
      media: createMediaRepository(owner.client),
      admin: createSupabaseMediaAdmin({ url: env.url, secretKey: env.secretKey }),
      processor: createSharpImageProcessor(),
      panoramas: createPanoramaRepository(owner.client),
      tours: createTourRepository(owner.client),
      renderer: createSharpSampleImageRenderer(),
      upload: async (url: string, bytes: Uint8Array, mime: string) =>
        (
          await fetch(url, {
            method: "PUT",
            headers: { "content-type": mime },
            body: bytes as Uint8Array<ArrayBuffer>,
          })
        ).ok,
      now: () => new Date(),
    };
  }

  it("knows it is a demo, in the panel and on the portal", async () => {
    expect(membership.demo).toBe(true);
    const directory = createSupabaseTenantDirectory({
      url: env.url,
      publishableKey: env.publishableKey,
    });
    expect((await directory.findByHost(hostname))?.demo).toBe(true);
    // Demo Sur, a real municipality of the seed, is not.
    expect((await directory.findByHost("demo-sur.localhost"))?.demo).toBeUndefined();
  });

  it("loads the sample content once, published and around the center", async () => {
    const d = deps();
    const result = await loadSampleContent(membership, { center: "-17.3901, -66.1502" }, d);
    expect(result).toEqual({
      status: "loaded",
      destinations: SAMPLE_DESTINATIONS.length,
      events: SAMPLE_EVENTS.length,
      panoramas: 2,
    });

    const destinations = await d.content.listDestinations(tenantId);
    expect(destinations.map((entry) => entry.status)).toEqual(
      SAMPLE_DESTINATIONS.map(() => "published"),
    );
    const events = await d.content.listEvents(tenantId);
    expect(events.every((entry) => entry.status === "published" && !entry.ended)).toBe(true);

    // Visitors read them anonymously, with the municipality's name in the text.
    const [row] = await db`
      select count(*)::int as n,
             bool_and(summary not like '%{municipio}%') as filled
      from public.content_revisions r join public.content_items i on i.published_revision_id = r.id
      where i.tenant_id = ${tenantId}
    `;
    expect(row).toEqual({ n: SAMPLE_DESTINATIONS.length + SAMPLE_EVENTS.length, filled: true });
    const [plaza] = await db`
      select r.latitude, r.longitude, r.summary from public.content_revisions r
      join public.content_items i on i.published_revision_id = r.id
      where i.tenant_id = ${tenantId} and i.slug = 'plaza-principal'
    `;
    expect(plaza).toMatchObject({ latitude: -17.3901, longitude: -66.1502 });
    expect(plaza?.summary).toContain("Demo Valle Integración");

    // The photos are real images with their derivatives in the public bucket.
    const [photo] = await db`
      select v.width, v.height, v.published_at is not null as public
      from public.asset_versions v join public.assets a on a.id = v.asset_id
      where v.tenant_id = ${tenantId} and a.purpose = 'content' limit 1
    `;
    expect(photo).toEqual({ width: 1600, height: 1067, public: true });

    // The two panoramas went to the pipeline (a durable job each).
    const panoramas = await d.panoramas.list(tenantId);
    expect(panoramas.map((panorama) => panorama.status).sort()).toEqual([
      "processing",
      "processing",
    ]);

    // Loading again changes nothing.
    expect(await loadSampleContent(membership, { center: "-17.3901, -66.1502" }, d)).toEqual({
      status: "loaded",
      destinations: 0,
      events: 0,
      panoramas: 0,
    });
    expect((await loadSampleContentStatus(membership, d))?.tour).toBe("processing");
  });

  it("builds and publishes the sample tour once the panoramas are ready", async () => {
    const d = deps();
    // Stand in for the pipeline: small renditions and a ready manifest.
    const versions = await db`
      select v.id, v.asset_id, v.version from public.asset_versions v
      join public.assets a on a.id = v.asset_id
      where v.tenant_id = ${tenantId} and a.purpose = 'panorama' order by v.created_at
    `;
    for (const version of versions) {
      const webp = (width: number) =>
        sharp({ create: { width, height: width / 2, channels: 3, background: "#6688aa" } })
          .webp()
          .toBuffer();
      const [preview, image] = await Promise.all([webp(256), webp(512)]);
      await d.admin.storeDerivatives(
        `${tenantId}/${version.asset_id}/${version.version}/panorama/`,
        [
          { name: "preview.webp", bytes: new Uint8Array(preview), contentType: "image/webp" },
          { name: "image.webp", bytes: new Uint8Array(image), contentType: "image/webp" },
        ],
      );
      const manifest = {
        version: 1,
        projection: "equirectangular",
        source: {
          width: 4096,
          height: 2048,
          bytes: 1000,
          mime: "image/jpeg",
          sha256: "a".repeat(64),
        },
        preview: { file: "preview.webp", width: 256, height: 128, bytes: preview.length },
        image: { file: "image.webp", width: 512, height: 256, bytes: image.length },
        tiles: null,
      };
      await db`
        update public.asset_versions
        set status = 'ready', mime = 'image/jpeg', bytes = 1000, width = 4096, height = 2048,
            sha256 = ${"e".repeat(64)}, ready_at = now(), manifest = ${db.json(manifest)}
        where id = ${version.id}
      `;
    }
    expect((await loadSampleContentStatus(membership, d))?.tour).toBe("ready");

    expect(await buildSampleTour(membership, d)).toEqual({ status: "built" });
    expect(await buildSampleTour(membership, d)).toEqual({ status: "exists" });
    expect((await loadSampleContentStatus(membership, d))?.tour).toBe("built");

    const [tour] = await db`
      select jsonb_array_length(r.manifest -> 'scenes') as scenes,
             (select count(*)::int from jsonb_array_elements(r.manifest -> 'scenes') s,
                     jsonb_array_elements(s -> 'hotspots') h) as points
      from public.tours t join public.tour_revisions r on r.id = t.published_revision_id
      where t.tenant_id = ${tenantId}
    `;
    expect(tour).toEqual({ scenes: 2, points: 3 });
  });

  it("emails an invitation through SMTP, once", async () => {
    const invitee = `invitada-${tenantId.slice(0, 8)}@example.test`;
    const [user] = await db`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              ${invitee}, now(), now(), now())
      returning id
    `;
    expect(
      await createMemberRepository(owner.client).add(tenantId, String(user?.id), "editor"),
    ).toEqual({
      status: "done",
    });

    const ledger = createPostgresJobLedger({
      url: DB_URL,
      role: "rikuy_worker",
      maxConnections: 2,
    });
    try {
      const processor = createMembershipInvitationMailProcessor({
        invitations: ledger.invitations,
        mailer: createSmtpMailer({
          host: "127.0.0.1",
          port: SMTP_PORT,
          from: "Rikuy <avisos@rikuy.example.test>",
        }),
        adminOrigin: "http://app.localhost:3000",
      });
      // Only this demo's jobs: earlier suites may have left invitations of other tenants.
      await db`
        update public.background_jobs set status = 'succeeded', finished_at = now()
        where kind = 'mail.membership_invitation' and status = 'pending' and tenant_id <> ${tenantId}
      `;
      const report = await drainJobs({
        ledger,
        processors: [processor],
        runnerId: "it-mail",
        budgetMs: 15_000,
      });
      expect(report.succeeded).toBeGreaterThanOrEqual(1);
      // A second pass finds nothing to send.
      await drainJobs({ ledger, processors: [processor], runnerId: "it-mail-2", budgetMs: 3_000 });
    } finally {
      await ledger.close();
    }

    const search = (await mailpit(`/search?query=${encodeURIComponent(`to:"${invitee}"`)}`)) as {
      messages?: { ID: string; Subject: string }[];
    };
    expect(search.messages?.map((message) => message.Subject)).toEqual([
      "Invitación al panel de Demo Valle Integración",
    ]);
    const message = (await mailpit(`/message/${search.messages?.[0]?.ID ?? "none"}`)) as {
      Text?: string;
    };
    expect(message.Text).toContain("como editor");
    expect(message.Text).toContain("http://app.localhost:3000");
    const members = await createMemberRepository(owner.client).list(tenantId);
    expect(members.find((member) => member.email === invitee)?.invitationMailedAt).not.toBeNull();
  });
});
