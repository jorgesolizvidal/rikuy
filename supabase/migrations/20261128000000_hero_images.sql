-- Lighter versions of the portal's home cover (ADR-070) — expand only.
--
-- The home cover is the largest element of the portal's home on a phone (its LCP). It sits
-- under a dark veil and the title, so a lower quality does not show: every content photo
-- gets "hero" versions (800 and 1200 px, WebP at quality 60) next to its derivatives.
--
-- - New uploads store them with the rest of their derivatives (the web, at confirm).
-- - Photos uploaded before get them from a job, media.hero_images, enqueued once below.
-- - A publication copies them when the private folder has them; the job copies them for a
--   photo already public.
-- - The portal uses them only when both are in the public bucket: `private.public_image`
--   says `"hero": true` then. So a photo without them (yet) keeps its regular versions,
--   and a cover never points to a file that is not there.

-- ── 1. The job ──────────────────────────────────────────────────────────────

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values ('media.hero_images', 'media', 4, 60, 120, 2, 'Versiones livianas de la portada de una foto');

create or replace function private.is_valid_job_payload(p_kind text, p_payload jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    -- {"mode": "ok" | "fail_once" | "fail_always", "workMs": 0..10000}, both optional.
    when p_kind = 'system.probe' then
      jsonb_typeof(p_payload) = 'object'
      and not exists (
        select 1 from jsonb_object_keys(p_payload) k where k not in ('mode', 'workMs')
      )
      and (not p_payload ? 'mode' or p_payload ->> 'mode' in ('ok', 'fail_once', 'fail_always'))
      and (
        not p_payload ? 'workMs'
        or (
          jsonb_typeof(p_payload -> 'workMs') = 'number'
          and (p_payload ->> 'workMs') ~ '^[0-9]{1,5}$'
          and (p_payload ->> 'workMs')::integer between 0 and 10000
        )
      )
    -- {"versionId": uuid}; the job's subject is the same version.
    when p_kind in ('media.expire_abandoned_upload', 'media.process_panorama', 'media.process_model',
                    'media.remove_unused', 'media.extract_document', 'media.hero_images') then
      jsonb_typeof(p_payload) = 'object'
      and not exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'versionId')
      and coalesce(p_payload ->> 'versionId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    -- {"membershipId": uuid}; the job's subject is the same membership. Never the address:
    -- the runner reads it under the job's lease.
    when p_kind = 'mail.membership_invitation' then
      jsonb_typeof(p_payload) = 'object'
      and not exists (select 1 from jsonb_object_keys(p_payload) k where k <> 'membershipId')
      and coalesce(p_payload ->> 'membershipId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    -- {"source": "content" | "tour", "revisionId": uuid}; the job's subject is that revision.
    when p_kind = 'knowledge.index' then
      jsonb_typeof(p_payload) = 'object'
      and private.has_exact_keys(p_payload, array['source', 'revisionId'])
      and p_payload ->> 'source' in ('content', 'tour')
      and coalesce(p_payload ->> 'revisionId', '')
        ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    -- {}: the job's tenant is what gets probed (ADR-044).
    when p_kind = 'metrics.probe_portal' then
      p_payload = '{}'::jsonb
    -- {"month": "YYYY-MM-01", "manual": bool}: the job's tenant is the report's (ADR-055).
    when p_kind = 'reports.monthly' then
      jsonb_typeof(p_payload) = 'object'
      and private.has_exact_keys(p_payload, array['month', 'manual'])
      and coalesce(p_payload ->> 'month', '') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-01$'
      and jsonb_typeof(p_payload -> 'manual') = 'boolean'
    else false
  end;
$$;

-- ── 2. Where the files are ──────────────────────────────────────────────────

-- Both hero versions of a version are stored in that bucket.
create function private.has_hero_images(p_bucket text, p_asset_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) = 2
  from public.asset_versions v
  join storage.objects o
    on o.bucket_id = p_bucket
   and o.name in (
     v.tenant_id::text || '/' || v.asset_id::text || '/' || v.version::text || '/hero-w800.webp',
     v.tenant_id::text || '/' || v.asset_id::text || '/' || v.version::text || '/hero-w1200.webp'
   )
  where v.id = p_asset_version_id;
$$;

revoke all on function private.has_hero_images(text, uuid) from public;

-- One published image: {assetId, version, alt, width, height} of the original, and
-- "hero": true when its hero versions are public (absent otherwise).
create or replace function private.public_image(p_asset_version_id uuid, p_alt text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'assetId', v.asset_id, 'version', v.version, 'alt', p_alt,
    'width', v.width, 'height', v.height
  ) || case
         when private.has_hero_images('media-public', v.id) then '{"hero": true}'::jsonb
         else '{}'::jsonb
       end
  from public.asset_versions v
  where v.id = p_asset_version_id and v.status = 'ready' and v.published_at is not null;
$$;

revoke all on function private.public_image(uuid, text) from public;

-- ── 3. The job's reads and writes (worker_api, under its lease) ────────────

-- The ready content photo of the job: where its original is, and whether it is public.
-- Nothing when the version is gone, rejected or not a content photo.
create function worker_api.hero_image_source(p_job_id uuid, p_fencing_token bigint)
returns table (tenant_id uuid, asset_id uuid, version integer, original_path text, published boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'media.hero_images' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  v_version := private.job_asset_version(v_job);
  if v_version.id is null or v_version.status <> 'ready' or not exists (
    select 1 from public.assets a
    where a.tenant_id = v_version.tenant_id and a.id = v_version.asset_id and a.purpose = 'content'
  ) then
    return;
  end if;
  return query select v_version.tenant_id, v_version.asset_id, v_version.version,
                      v_version.original_path, v_version.published_at is not null;
end;
$$;

-- The files are stored: measured again for the quota. "missing" when they are not there.
create function worker_api.complete_hero_images(p_job_id uuid, p_fencing_token bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'media.hero_images' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  v_version := private.job_asset_version(v_job);
  if v_version.id is null or v_version.status <> 'ready' then
    return 'gone';
  end if;
  if not private.has_hero_images('media-originals', v_version.id) then
    return 'missing';
  end if;
  perform private.settle_usage(
    'storage_bytes', v_version.id, private.measure_version_bytes(v_version.id), 'settled'
  );
  return 'done';
end;
$$;

revoke all on function worker_api.hero_image_source(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function worker_api.complete_hero_images(uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function worker_api.hero_image_source(uuid, bigint) to rikuy_worker;
grant execute on function worker_api.complete_hero_images(uuid, bigint) to rikuy_worker;

-- ── 4. Photos uploaded before ───────────────────────────────────────────────

-- One job per ready content photo without its private hero versions (once per version).
create function private.enqueue_hero_images(p_limit integer default 1000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_version record;
  v_created integer := 0;
  v_new boolean;
begin
  for v_version in
    select v.id, v.tenant_id
    from public.asset_versions v
    join public.assets a on a.id = v.asset_id and a.tenant_id = v.tenant_id
    where a.purpose = 'content' and v.status = 'ready'
      and not private.has_hero_images('media-originals', v.id)
      and not exists (
        select 1 from public.background_jobs j
        where j.tenant_id = v.tenant_id and j.kind = 'media.hero_images'
          and j.logical_key = 'asset_version:' || v.id::text
      )
    -- What visitors see first: published photos, newest first.
    order by (v.published_at is null), v.published_at desc nulls last, v.ready_at desc
    limit greatest(least(coalesce(p_limit, 1000), 5000), 1)
  loop
    select e.created into v_new
    from private.enqueue_job(
      v_version.tenant_id, 'media.hero_images', 'asset_version:' || v_version.id::text,
      jsonb_build_object('versionId', v_version.id), 'asset_version', v_version.id
    ) e;
    if v_new then
      v_created := v_created + 1;
    end if;
  end loop;
  return v_created;
end;
$$;

revoke all on function private.enqueue_hero_images(integer) from public;

-- The photos already uploaded (in production, ~60): the runner is woken up as usual.
select private.enqueue_hero_images();
