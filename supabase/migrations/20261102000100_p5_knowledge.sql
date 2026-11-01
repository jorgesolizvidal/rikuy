-- ─────────────────────────────────────────────────────────────────────────────
-- P5 · Paso 2: the assistant's knowledge (ADR-037).
--
--   * «Conocimiento del asistente» is a content kind ('knowledge') with the same revision
--     flow as destinations and events, plus an optional document (TXT or PDF with text) and
--     «Retirar» (empty published pointer; the sealed revisions stay).
--   * Documents are media of purpose 'document' (≤ 20 MB). submit_document enqueues
--     media.extract_document; the runner checks the real bytes, extracts the text per page
--     next to the original ({tenant}/{asset}/{version}/document/text.json) and keeps a
--     manifest. Only the assistant uses them: never copied to the public bucket.
--   * knowledge_chunks: fragments of SEALED revisions only (content and tours), written by
--     knowledge.index, enqueued by a trigger whenever a published pointer changes.
--   * Visibility is checked by every search against the CURRENT published pointer of the
--     chunk's content or tour, in the same municipality: a draft never has chunks, and a
--     retired or replaced document stops appearing in the transaction that retires it.
--   * Spanish full-text search without accents; ai_api.search_knowledge for the assistant
--     (rikuy_ai) and search_tenant_knowledge for members («Probar la búsqueda»).
--   * Kind guards: knowledge never has a tour, is never a tour's target, and never reaches
--     a portal read (those already filter destinations and events).
-- Expand-only.
-- Error codes: 42501 forbidden · 23514 invalid · PT404 unknown · PT409 conflict/state.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists unaccent with schema extensions;

-- unaccent() is STABLE (its dictionary could change); a generated column needs IMMUTABLE.
-- The dictionary is named explicitly, so the result only depends on the input.
create function private.unaccent_text(p text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, p);
$$;

revoke all on function private.unaccent_text(text) from public;

-- ── Documents: storage, versions and uploads ───────────────────────────────

update storage.buckets
set allowed_mime_types = array[
  'image/png', 'image/jpeg', 'image/webp', 'model/gltf-binary', 'image/ktx2',
  'application/pdf', 'text/plain', 'application/json'
]
where id = 'media-originals';

alter table public.asset_versions drop constraint asset_versions_declared_mime;
alter table public.asset_versions
  add constraint asset_versions_declared_mime check (
    declared_mime in (
      'image/png', 'image/jpeg', 'image/webp', 'model/gltf-binary', 'application/pdf', 'text/plain'
    )
  );

-- A ready document has no pixel size, like a model.
alter table public.asset_versions drop constraint asset_versions_ready_has_metadata;
alter table public.asset_versions
  add constraint asset_versions_ready_has_metadata check (
    status <> 'ready' or (
      bytes > 0 and sha256 ~ '^[0-9a-f]{64}$' and ready_at is not null
      and (
        (mime in ('image/png', 'image/jpeg', 'image/webp') and width > 0 and height > 0)
        or (mime in ('model/gltf-binary', 'application/pdf', 'text/plain') and width is null and height is null)
      )
    )
  );

-- Uploads: images and models as before; a document is a PDF or a text file, up to 20 MB.
create or replace function public.create_image_upload(
  p_tenant_id uuid,
  p_purpose public.asset_purpose,
  p_mime text,
  p_bytes integer
)
returns table (asset_id uuid, version_id uuid, version integer, original_path text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_asset uuid;
  v_version public.asset_versions%rowtype;
  -- (A CASE inside an IF condition confuses the PL/pgSQL parser: computed here.)
  v_max_bytes integer := case
    when p_purpose in ('panorama', 'model') then 52428800
    when p_purpose = 'document' then 20971520
    else 10485760
  end;
  v_mime_ok boolean := case
    when p_purpose = 'model' then p_mime = 'model/gltf-binary'
    when p_purpose = 'document' then p_mime in ('application/pdf', 'text/plain')
    else p_mime in ('image/png', 'image/jpeg', 'image/webp')
  end;
begin
  if not private.has_tenant_role(
       p_tenant_id,
       case when p_purpose = 'logo'
         then array['owner', 'admin']::public.membership_role[]
         else array['owner', 'admin', 'editor']::public.membership_role[]
       end)
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to upload media for this tenant' using errcode = '42501';
  end if;

  if p_bytes is null or p_bytes < 1 or p_bytes > v_max_bytes or not coalesce(v_mime_ok, false) then
    raise exception 'declared type or size out of range' using errcode = '23514';
  end if;

  if (
    select count(*) from public.asset_versions v
    where v.tenant_id = p_tenant_id and v.status = 'uploading' and v.created_at > now() - interval '1 hour'
  ) >= 20 then
    raise exception 'too many pending uploads' using errcode = 'PT429';
  end if;

  insert into public.assets (tenant_id, purpose, created_by)
  values (p_tenant_id, p_purpose, (select auth.uid()))
  returning id into v_asset;

  insert into public.asset_versions (tenant_id, asset_id, version, declared_mime, declared_bytes, created_by)
  values (p_tenant_id, v_asset, 1, p_mime, p_bytes, (select auth.uid()))
  returning * into v_version;

  return query select v_asset, v_version.id, v_version.version, v_version.original_path;
end;
$$;

-- What a finished extraction describes (contract: @rikuy/core documentManifestSchema).
create function private.is_valid_document_manifest(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
    and private.has_exact_keys(p, array['version', 'format', 'pages', 'characters', 'textFile', 'encoding'])
    and p -> 'version' = '1'::jsonb
    and p ->> 'format' in ('pdf', 'txt')
    and (
      jsonb_typeof(p -> 'pages') = 'null'
      or (jsonb_typeof(p -> 'pages') = 'number' and (p ->> 'pages') ~ '^[0-9]{1,4}$'
          and (p ->> 'pages')::integer between 1 and 2000)
    )
    and jsonb_typeof(p -> 'characters') = 'number'
    and (p ->> 'characters') ~ '^[0-9]{1,8}$'
    and (p ->> 'characters')::integer between 1 and 5000000
    and p ->> 'textFile' = 'document/text.json'
    and p ->> 'encoding' in ('utf-8', 'windows-1252', 'pdf');
$$;

revoke all on function private.is_valid_document_manifest(jsonb) from public;

-- ── Jobs ────────────────────────────────────────────────────────────────────

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values
  ('media.extract_document', 'media', 4, 120, 180, 1, 'Lectura de un documento de conocimiento'),
  ('knowledge.index', 'knowledge', 5, 60, 120, 2, 'Indexación del conocimiento del asistente');

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
                    'media.remove_unused', 'media.extract_document') then
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
    else false
  end;
$$;

-- ── Quotas: documents count like panoramas and models (ADR-027) ────────────

create or replace function private.reserve_media_upload()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purpose public.asset_purpose;
begin
  if new.status <> 'uploading' then
    return null;
  end if;
  select a.purpose into v_purpose from public.assets a
  where a.tenant_id = new.tenant_id and a.id = new.asset_id;
  perform private.reserve_usage(
    new.tenant_id, 'storage_bytes', new.id,
    ceil(new.declared_bytes * case when v_purpose in ('panorama', 'model', 'document') then 2 else 1.5 end)::bigint
  );
  if v_purpose in ('panorama', 'model', 'document') then
    perform private.reserve_usage(
      new.tenant_id, 'media_compute_seconds', new.id,
      (select k.max_active_seconds::bigint from public.job_kinds k
       where k.kind = case v_purpose
         when 'panorama' then 'media.process_panorama'
         when 'model' then 'media.process_model'
         else 'media.extract_document'
       end)
    );
  end if;
  return null;
end;
$$;

create or replace function private.settle_media_storage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'rejected' and old.status <> 'rejected' then
    perform private.settle_usage('storage_bytes', new.id, 0, 'released');
    -- No processing job will ever settle the compute of an upload that never got one.
    if not exists (
      select 1 from public.background_jobs j
      where j.tenant_id = new.tenant_id and j.subject_type = 'asset_version' and j.subject_id = new.id
        and j.kind in ('media.process_panorama', 'media.process_model', 'media.extract_document')
    ) then
      perform private.settle_usage('media_compute_seconds', new.id, 0, 'released');
    end if;
  elsif new.status = 'ready' and (
    old.status <> 'ready'
    or new.published_at is distinct from old.published_at
    or new.manifest is distinct from old.manifest
  ) then
    perform private.settle_usage('storage_bytes', new.id, private.measure_version_bytes(new.id), 'settled');
  end if;
  return null;
end;
$$;

create or replace function private.settle_media_compute()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind not in ('media.process_panorama', 'media.process_model', 'media.extract_document')
     or new.subject_type is distinct from 'asset_version'
     or new.status not in ('succeeded', 'dead_letter')
     or new.status = old.status then
    return null;
  end if;
  perform private.settle_usage(
    'media_compute_seconds', new.subject_id,
    (select coalesce(ceil(sum(extract(epoch from coalesce(a.finished_at, now()) - a.started_at))), 0)::bigint
     from public.job_attempts a where a.job_id = new.id),
    'settled'
  );
  return null;
end;
$$;

-- ── People: submit an uploaded document ────────────────────────────────────

create function public.submit_document(p_tenant_id uuid, p_version_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.asset_versions;
  v_job uuid;
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[])
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to submit documents for this tenant' using errcode = '42501';
  end if;

  select v.* into v_version
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
  where v.id = p_version_id and v.tenant_id = p_tenant_id and a.purpose = 'document'
  for update of v;
  if not found then
    raise exception 'document not found' using errcode = 'PT404';
  end if;
  -- Idempotent: submitting twice is harmless.
  if v_version.status <> 'uploading' then
    return v_version.status::text;
  end if;
  if not exists (
    select 1 from storage.objects o
    where o.bucket_id = 'media-originals' and o.name = v_version.original_path
  ) then
    raise exception 'the original was not uploaded' using errcode = 'PT409', hint = 'not_uploaded';
  end if;

  update public.asset_versions v set status = 'processing' where v.id = v_version.id;

  select e.job_id into v_job
  from private.enqueue_job(
    p_tenant_id, 'media.extract_document', 'asset_version:' || v_version.id::text,
    jsonb_build_object('versionId', v_version.id), 'asset_version', v_version.id
  ) e;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', p_tenant_id, (select auth.uid()), 'media.document_submitted', 'asset_version',
    v_version.id, v_job, 'success', jsonb_build_object('bytes', v_version.declared_bytes)
  );
  return 'processing';
end;
$$;

-- A document version of this tenant, as the editor shows it (any member).
create function public.document_version(p_tenant_id uuid, p_version_id uuid)
returns table (
  version_id          uuid,
  asset_id            uuid,
  version             integer,
  status              public.asset_version_status,
  declared_mime       text,
  declared_bytes      integer,
  rejected_reason     text,
  manifest            jsonb,
  job_status          public.job_status,
  job_last_error_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  return query
  select v.id, v.asset_id, v.version, v.status, v.declared_mime, v.declared_bytes,
         v.rejected_reason, v.manifest, j.status, j.last_error_code
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id and a.purpose = 'document'
  left join public.background_jobs j
    on j.tenant_id = v.tenant_id and j.kind = 'media.extract_document'
   and j.logical_key = 'asset_version:' || v.id::text
  where v.tenant_id = p_tenant_id and v.id = p_version_id;
end;
$$;

revoke all on function public.submit_document(uuid, uuid) from public, anon, authenticated;
revoke all on function public.document_version(uuid, uuid) from public, anon, authenticated;
grant execute on function public.submit_document(uuid, uuid) to authenticated;
grant execute on function public.document_version(uuid, uuid) to authenticated;

-- ── worker_api: the extraction, always under the job's lease ───────────────

create function private.job_document_version(p_job public.background_jobs)
returns public.asset_versions
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_version public.asset_versions;
begin
  if p_job.kind <> 'media.extract_document' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  v_version := private.job_asset_version(p_job);
  if v_version.id is null or not exists (
    select 1 from public.assets a
    where a.tenant_id = v_version.tenant_id and a.id = v_version.asset_id and a.purpose = 'document'
  ) then
    return null;
  end if;
  return v_version;
end;
$$;

revoke all on function private.job_document_version(public.background_jobs) from public;

create function worker_api.document_source(p_job_id uuid, p_fencing_token bigint)
returns table (status text, original_path text, declared_mime text, prefix text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.asset_versions;
begin
  v_version := private.job_document_version(private.leased_job(p_job_id, p_fencing_token));
  if v_version.id is null then
    return query select 'not_found'::text, null::text, null::text, null::text;
    return;
  end if;
  return query select
    v_version.status::text, v_version.original_path, v_version.declared_mime,
    v_version.tenant_id::text || '/' || v_version.asset_id::text || '/' || v_version.version::text || '/';
end;
$$;

create function worker_api.complete_document(
  p_job_id uuid,
  p_fencing_token bigint,
  p_mime text,
  p_bytes integer,
  p_sha256 text,
  p_manifest jsonb
)
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
  v_version := private.job_document_version(v_job);
  if v_version.id is null then
    return 'not_found';
  end if;
  if not private.is_valid_document_manifest(p_manifest)
     or p_mime not in ('application/pdf', 'text/plain')
     or (p_mime = 'application/pdf') <> (p_manifest ->> 'format' = 'pdf') then
    raise exception 'invalid document manifest' using errcode = '23514';
  end if;

  update public.asset_versions v
  set status = 'ready', mime = p_mime, bytes = p_bytes, sha256 = p_sha256,
      manifest = p_manifest, ready_at = now()
  where v.id = v_version.id and v.status = 'processing';
  if not found then
    return 'already_settled';
  end if;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', v_job.tenant_id, null, 'media.document_ready', 'asset_version', v_version.id,
    v_job.id, 'success',
    jsonb_build_object('format', p_manifest ->> 'format', 'pages', p_manifest -> 'pages',
                       'characters', p_manifest -> 'characters')
  );
  return 'ready';
end;
$$;

create function worker_api.reject_document(p_job_id uuid, p_fencing_token bigint, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_version public.asset_versions;
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 200), '');
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  v_version := private.job_document_version(v_job);
  if v_version.id is null then
    return 'not_found';
  end if;
  if v_reason is null then
    raise exception 'a reason is required' using errcode = '23514';
  end if;

  update public.asset_versions v
  set status = 'rejected', rejected_reason = v_reason
  where v.id = v_version.id and v.status = 'processing';
  if not found then
    return 'already_settled';
  end if;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome, diff
  )
  values (
    'tenant', v_job.tenant_id, null, 'media.document_rejected', 'asset_version', v_version.id,
    v_job.id, 'success', jsonb_build_object('reason', v_reason)
  );
  return 'rejected';
end;
$$;

revoke all on function worker_api.document_source(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function worker_api.complete_document(uuid, bigint, text, integer, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function worker_api.reject_document(uuid, bigint, text) from public, anon, authenticated, service_role;
grant execute on function worker_api.document_source(uuid, bigint) to rikuy_worker;
grant execute on function worker_api.complete_document(uuid, bigint, text, integer, text, jsonb) to rikuy_worker;
grant execute on function worker_api.reject_document(uuid, bigint, text) to rikuy_worker;

-- ── Knowledge content: revisions with a document ───────────────────────────

alter table public.content_revisions add column document_version_id uuid;
alter table public.content_revisions
  add constraint content_revisions_document_fkey foreign key (tenant_id, document_version_id)
    references public.asset_versions (tenant_id, id) on delete restrict;
create index content_revisions_document_idx on public.content_revisions (tenant_id, document_version_id)
  where document_version_id is not null;

create function private.is_valid_knowledge_draft(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
    and private.has_exact_keys(p, array['title', 'summary', 'body', 'document'])
    and private.is_plain_line(p -> 'title', 1, 120)
    and private.is_plain_line(p -> 'summary', 0, 300)
    and private.is_valid_rich_text(p -> 'body')
    and (
      jsonb_typeof(p -> 'document') = 'null'
      or (
        private.has_exact_keys(p -> 'document', array['assetId', 'version'])
        and coalesce(p #>> '{document,assetId}', '')
          ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        and jsonb_typeof(p #> '{document,version}') = 'number'
        and (p #>> '{document,version}') ~ '^[0-9]{1,6}$'
      )
    );
$$;

revoke all on function private.is_valid_knowledge_draft(jsonb) from public;

-- The document version a draft names: of this tenant, a document, not rejected.
create function private.knowledge_document_version(p_tenant_id uuid, p_reference jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if jsonb_typeof(p_reference) <> 'object' then
    return null;
  end if;
  select v.id into v_id
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
  where v.tenant_id = p_tenant_id
    and a.purpose = 'document'
    and v.asset_id = (p_reference ->> 'assetId')::uuid
    and v.version = (p_reference ->> 'version')::integer
    and v.status in ('processing', 'ready');
  if v_id is null then
    raise exception 'the document is not available for this tenant' using errcode = '23514', hint = 'document';
  end if;
  return v_id;
end;
$$;

revoke all on function private.knowledge_document_version(uuid, jsonb) from public;

create or replace function private.revision_document(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when i.kind = 'event' then base.doc || jsonb_build_object(
      'schedule', private.event_schedule_json(r.starts_local, r.ends_local, r.all_day),
      'venueId', r.venue_content_id)
    when i.kind = 'knowledge' then jsonb_build_object(
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      'document', coalesce((
        select jsonb_build_object('assetId', v.asset_id, 'version', v.version)
        from public.asset_versions v
        where v.tenant_id = r.tenant_id and v.id = r.document_version_id
      ), 'null'::jsonb))
    else base.doc end
  from public.content_revisions r
  join public.content_items i on i.id = r.content_id
  cross join lateral (
    select jsonb_build_object(
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      'location', case when r.latitude is null then 'null'::jsonb
                       else jsonb_build_object('lat', r.latitude, 'lng', r.longitude) end,
      'cover', coalesce((
        select jsonb_build_object('assetId', v.asset_id, 'version', v.version, 'alt', m.alt_text)
        from public.media_references m
        join public.asset_versions v on v.tenant_id = m.tenant_id and v.id = m.asset_version_id
        where m.revision_id = r.id and m.purpose = 'cover'
      ), 'null'::jsonb),
      'gallery', coalesce((
        select jsonb_agg(jsonb_build_object('assetId', v.asset_id, 'version', v.version, 'alt', m.alt_text)
                         order by m.position)
        from public.media_references m
        join public.asset_versions v on v.tenant_id = m.tenant_id and v.id = m.asset_version_id
        where m.revision_id = r.id and m.purpose = 'gallery'
      ), '[]'::jsonb)
    ) as doc
  ) base
  where r.id = p_revision_id;
$$;

create or replace function public.save_content_draft(
  p_tenant_id uuid,
  p_content_id uuid,
  p_document jsonb,
  p_expected_edit integer
)
returns table (revision_id uuid, revision_no integer, edit_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item public.content_items%rowtype;
  v_draft public.content_revisions%rowtype;
  v_image jsonb;
  v_position integer := 0;
  v_starts timestamp;
  v_ends timestamp;
  v_all_day boolean;
  v_venue uuid;
  v_document uuid;
  v_valid boolean;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;

  v_valid := case v_item.kind
    when 'event' then private.is_valid_event_draft(p_document)
    when 'knowledge' then private.is_valid_knowledge_draft(p_document)
    else private.is_valid_destination_draft(p_document)
  end;
  if p_document is null or not coalesce(v_valid, false) then
    raise exception 'invalid content document' using errcode = '23514';
  end if;

  if v_item.kind = 'event' then
    select s.starts_local, s.ends_local, s.all_day into v_starts, v_ends, v_all_day
    from private.parse_event_schedule(p_document -> 'schedule') s;
    if jsonb_typeof(p_document -> 'venueId') = 'string' then
      v_venue := (p_document ->> 'venueId')::uuid;
      if not exists (
        select 1 from public.content_items d
        where d.tenant_id = p_tenant_id and d.id = v_venue and d.kind = 'destination'
      ) then
        raise exception 'the venue is not a destination of this tenant' using errcode = '23514', hint = 'venue';
      end if;
    end if;
  elsif v_item.kind = 'knowledge' then
    v_document := private.knowledge_document_version(p_tenant_id, p_document -> 'document');
  end if;

  if v_item.draft_revision_id is null then
    if p_expected_edit is not null then
      raise exception 'the draft was published or discarded meanwhile' using errcode = 'PT409';
    end if;
    insert into public.content_revisions (tenant_id, content_id, revision_no, title, created_by, updated_by)
    values (
      p_tenant_id, p_content_id,
      (select max(r.revision_no) + 1 from public.content_revisions r where r.content_id = p_content_id),
      p_document ->> 'title', (select auth.uid()), (select auth.uid())
    )
    returning * into v_draft;
    update public.content_items i set draft_revision_id = v_draft.id, updated_at = now()
    where i.id = p_content_id;
  else
    select r.* into v_draft from public.content_revisions r where r.id = v_item.draft_revision_id for update;
    if p_expected_edit is distinct from v_draft.edit_count then
      raise exception 'the draft changed meanwhile' using errcode = 'PT409';
    end if;
  end if;

  update public.content_revisions r
  set title = p_document ->> 'title',
      summary = p_document ->> 'summary',
      body = p_document -> 'body',
      latitude = (p_document #>> '{location,lat}')::double precision,
      longitude = (p_document #>> '{location,lng}')::double precision,
      starts_local = v_starts,
      ends_local = v_ends,
      all_day = v_all_day,
      venue_content_id = v_venue,
      document_version_id = v_document,
      edit_count = case when v_item.draft_revision_id is null then r.edit_count else r.edit_count + 1 end,
      updated_by = (select auth.uid()),
      updated_at = now()
  where r.id = v_draft.id
  returning * into v_draft;

  delete from public.media_references m where m.revision_id = v_draft.id;
  if jsonb_typeof(p_document -> 'cover') = 'object' then
    insert into public.media_references (tenant_id, revision_id, asset_version_id, purpose, position, alt_text)
    values (p_tenant_id, v_draft.id,
            private.content_image_version(p_tenant_id, p_document -> 'cover', false),
            'cover', 0, p_document #>> '{cover,alt}');
  end if;
  if jsonb_typeof(p_document -> 'gallery') = 'array' then
    for v_image in select value from jsonb_array_elements(p_document -> 'gallery') loop
      insert into public.media_references (tenant_id, revision_id, asset_version_id, purpose, position, alt_text)
      values (p_tenant_id, v_draft.id,
              private.content_image_version(p_tenant_id, v_image, false),
              'gallery', v_position, v_image ->> 'alt');
      v_position := v_position + 1;
    end loop;
  end if;

  update public.content_items i set updated_at = now() where i.id = p_content_id;

  return query select v_draft.id, v_draft.revision_no, v_draft.edit_count;
end;
$$;

create or replace function public.publish_content(
  p_tenant_id uuid,
  p_content_id uuid,
  p_expected_edit integer
)
returns table (revision_id uuid, revision_no integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_item public.content_items%rowtype;
  v_draft public.content_revisions%rowtype;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;
  if v_item.draft_revision_id is null then
    raise exception 'there is no draft to publish' using errcode = 'PT409';
  end if;

  select r.* into v_draft from public.content_revisions r where r.id = v_item.draft_revision_id for update;
  if v_draft.edit_count is distinct from p_expected_edit then
    raise exception 'the draft changed meanwhile' using errcode = 'PT409';
  end if;

  if v_item.kind = 'knowledge' then
    -- The assistant needs something to read: its own text or a document.
    if v_draft.body = '[]'::jsonb and v_draft.document_version_id is null then
      raise exception 'the knowledge has no text and no document' using errcode = '23514', hint = 'incomplete';
    end if;
    if v_draft.document_version_id is not null and not exists (
      select 1 from public.asset_versions v
      where v.tenant_id = p_tenant_id and v.id = v_draft.document_version_id and v.status = 'ready'
    ) then
      raise exception 'the document is not read yet' using errcode = 'PT409', hint = 'document';
    end if;
  -- Visitors need a summary and a location; events also need their date.
  elsif v_draft.summary = '' or v_draft.latitude is null
     or (v_item.kind = 'event' and v_draft.starts_local is null) then
    raise exception 'the content is missing what visitors need to see it'
      using errcode = '23514', hint = 'incomplete';
  end if;
  -- Its images' public derivatives must exist before the portal can point at them.
  if exists (
    select 1
    from public.media_references m
    join public.asset_versions v on v.tenant_id = m.tenant_id and v.id = m.asset_version_id
    where m.revision_id = v_draft.id and (v.status <> 'ready' or v.published_at is null)
  ) then
    raise exception 'an image is not published yet' using errcode = 'PT409', hint = 'media';
  end if;

  update public.content_revisions r
  set state = 'sealed', sealed_at = now(), sealed_by = (select auth.uid())
  where r.id = v_draft.id;

  update public.content_items i
  set published_revision_id = v_draft.id, draft_revision_id = null, published_at = now(), updated_at = now()
  where i.id = p_content_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'content.published', 'content_item', p_content_id,
          v_draft.revision_no, 'success',
          jsonb_build_object('kind', v_item.kind, 'revision_id', v_draft.id,
                             'previous_revision_id', v_item.published_revision_id));

  return query select v_draft.id, v_draft.revision_no;
end;
$$;

-- «Retirar»: the assistant stops using a knowledge item at once (its sealed revisions stay,
-- so «Volver a esta versión» publishes it again). Only knowledge: destinations and events
-- are not retired yet.
create function public.retire_content(p_tenant_id uuid, p_content_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.content_items%rowtype;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);

  select i.* into v_item
  from public.content_items i
  where i.id = p_content_id and i.tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'content not found' using errcode = 'PT404';
  end if;
  if v_item.kind <> 'knowledge' then
    raise exception 'only knowledge can be retired' using errcode = '23514', hint = 'kind';
  end if;
  if v_item.published_revision_id is null then
    raise exception 'it is not published' using errcode = 'PT409';
  end if;

  update public.content_items i
  set published_revision_id = null, published_at = null, updated_at = now()
  where i.id = p_content_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'content.retired', 'content_item', p_content_id,
          'success', jsonb_build_object('kind', v_item.kind, 'revision_id', v_item.published_revision_id));
end;
$$;

revoke all on function public.retire_content(uuid, uuid) from public, anon, authenticated;
grant execute on function public.retire_content(uuid, uuid) to authenticated;

-- ── Kind guards: knowledge is never a tour, nor a tour's destination ───────

create function private.assert_tour_content_kind()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.content_items i
    where i.tenant_id = new.tenant_id and i.id = new.content_id and i.kind in ('destination', 'event')
  ) then
    raise exception 'only destinations and events have tours' using errcode = '23514', hint = 'kind';
  end if;
  return new;
end;
$$;

create trigger tours_content_kind
  before insert or update of content_id on public.tours
  for each row execute function private.assert_tour_content_kind();

create function private.assert_hotspot_target_kind()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_content_id is not null and not exists (
    select 1 from public.content_items i
    where i.tenant_id = new.tenant_id and i.id = new.target_content_id and i.kind in ('destination', 'event')
  ) then
    raise exception 'the target must be another destination or event of this municipality'
      using errcode = '23514', hint = 'target';
  end if;
  return new;
end;
$$;

create trigger tour_hotspots_target_kind
  before insert or update of target_content_id on public.tour_hotspots
  for each row execute function private.assert_hotspot_target_kind();

revoke all on function private.assert_tour_content_kind() from public;
revoke all on function private.assert_hotspot_target_kind() from public;

create or replace function public.tour_hotspot_targets(p_tenant_id uuid, p_tour_id uuid)
returns table (
  content_id     uuid,
  kind           public.content_kind,
  title          text,
  published      boolean,
  tour_published boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  return query
  select i.id, i.kind, coalesce(cd.title, cp.title), i.published_revision_id is not null,
         exists (select 1 from public.tours t where t.tenant_id = i.tenant_id and t.content_id = i.id
                 and t.published_revision_id is not null)
  from public.content_items i
  left join public.content_revisions cd on cd.id = i.draft_revision_id
  left join public.content_revisions cp on cp.id = i.published_revision_id
  where i.tenant_id = p_tenant_id
    and i.kind in ('destination', 'event')
    and i.id is distinct from (select t.content_id from public.tours t where t.id = p_tour_id and t.tenant_id = p_tenant_id)
  order by i.kind, coalesce(cd.title, cp.title);
end;
$$;

-- ── Chunks ──────────────────────────────────────────────────────────────────

create table public.knowledge_chunks (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  content_id          uuid,
  content_revision_id uuid,
  tour_id             uuid,
  tour_revision_id    uuid,
  chunker_version     smallint not null,
  chunk_no            integer not null,
  -- The source's title (denormalized: sealed revisions never change).
  title               text not null,
  -- Section, scene or tour point the fragment belongs to.
  heading             text,
  body                text not null,
  page_from           integer,
  page_to             integer,
  scene_id            uuid,
  hotspot_id          uuid,
  sha256              text not null,
  locale              text not null default 'es',
  search              tsvector generated always as (
    setweight(to_tsvector('spanish'::regconfig, private.unaccent_text(title || ' ' || coalesce(heading, ''))), 'A')
    || setweight(to_tsvector('spanish'::regconfig, private.unaccent_text(body)), 'B')
  ) stored,
  created_at          timestamptz not null default now(),

  constraint knowledge_chunks_one_source check (
    (content_revision_id is not null and content_id is not null and tour_revision_id is null and tour_id is null)
    or (tour_revision_id is not null and tour_id is not null and content_revision_id is null and content_id is null)
  ),
  constraint knowledge_chunks_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete restrict,
  constraint knowledge_chunks_content_revision_fkey foreign key (content_id, content_revision_id)
    references public.content_revisions (content_id, id) on delete restrict,
  constraint knowledge_chunks_tour_fkey foreign key (tenant_id, tour_id)
    references public.tours (tenant_id, id) on delete restrict,
  constraint knowledge_chunks_tour_revision_fkey foreign key (tour_id, tour_revision_id)
    references public.tour_revisions (tour_id, id) on delete restrict,
  constraint knowledge_chunks_content_no_key unique (content_revision_id, chunk_no),
  constraint knowledge_chunks_tour_no_key unique (tour_revision_id, chunk_no),
  constraint knowledge_chunks_chunk_no check (chunk_no between 0 and 4999),
  constraint knowledge_chunks_chunker check (chunker_version between 1 and 100),
  constraint knowledge_chunks_title check (char_length(title) between 1 and 160 and title !~ '[[:cntrl:]]'),
  constraint knowledge_chunks_heading check (
    heading is null or (char_length(heading) between 1 and 300 and heading !~ '[[:cntrl:]]')
  ),
  constraint knowledge_chunks_body check (char_length(body) between 1 and 4000),
  constraint knowledge_chunks_pages check (
    (page_from is null) = (page_to is null)
    and (page_from is null or (page_from between 1 and 9999 and page_to between page_from and 9999))
  ),
  constraint knowledge_chunks_tour_points check (
    (scene_id is null and hotspot_id is null) or tour_revision_id is not null
  ),
  constraint knowledge_chunks_sha256 check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint knowledge_chunks_locale check (locale in ('es'))
);

create index knowledge_chunks_search_idx on public.knowledge_chunks using gin (search);
create index knowledge_chunks_content_revision_idx on public.knowledge_chunks (tenant_id, content_revision_id);
create index knowledge_chunks_tour_revision_idx on public.knowledge_chunks (tenant_id, tour_revision_id);

-- One row per indexed revision (also when it produced no chunk): what the panel shows.
create table public.knowledge_indexed_revisions (
  tenant_id           uuid not null references public.tenants (id) on delete restrict,
  content_revision_id uuid,
  tour_revision_id    uuid,
  chunker_version     smallint not null,
  chunks              integer not null,
  characters          integer not null,
  job_id              uuid,
  indexed_at          timestamptz not null default now(),

  constraint knowledge_indexed_revisions_one_source check (
    (content_revision_id is null) <> (tour_revision_id is null)
  ),
  constraint knowledge_indexed_revisions_content_fkey foreign key (tenant_id, content_revision_id)
    references public.content_revisions (tenant_id, id) on delete restrict,
  constraint knowledge_indexed_revisions_tour_fkey foreign key (tenant_id, tour_revision_id)
    references public.tour_revisions (tenant_id, id) on delete restrict,
  constraint knowledge_indexed_revisions_counts check (chunks >= 0 and characters >= 0)
);

create unique index knowledge_indexed_revisions_content_key
  on public.knowledge_indexed_revisions (content_revision_id) where content_revision_id is not null;
create unique index knowledge_indexed_revisions_tour_key
  on public.knowledge_indexed_revisions (tour_revision_id) where tour_revision_id is not null;

alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_indexed_revisions enable row level security;
-- No policies: read only through the search and status functions below.
revoke all on table public.knowledge_chunks, public.knowledge_indexed_revisions from public, anon, authenticated, service_role;

-- Only sealed revisions can have chunks (a draft is never in the assistant's knowledge).
create function private.assert_chunk_source_sealed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.content_revision_id is not null and not exists (
    select 1 from public.content_revisions r
    where r.id = new.content_revision_id and r.tenant_id = new.tenant_id and r.state = 'sealed'
  ) then
    raise exception 'only sealed revisions are indexed' using errcode = '23514';
  end if;
  if new.tour_revision_id is not null and not exists (
    select 1 from public.tour_revisions r
    where r.id = new.tour_revision_id and r.tenant_id = new.tenant_id and r.state = 'sealed'
  ) then
    raise exception 'only sealed revisions are indexed' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger knowledge_chunks_source_sealed
  before insert or update on public.knowledge_chunks
  for each row execute function private.assert_chunk_source_sealed();

revoke all on function private.assert_chunk_source_sealed() from public;

-- ── Indexing: a job whenever a published pointer changes ───────────────────

create function private.enqueue_knowledge_index(p_tenant_id uuid, p_source text, p_revision_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  -- Chunker version 1 is in the key: the same sealed revision is indexed once.
  select null from private.enqueue_job(
    p_tenant_id, 'knowledge.index', p_source || '_revision:' || p_revision_id::text || ':1',
    jsonb_build_object('source', p_source, 'revisionId', p_revision_id),
    p_source || '_revision', p_revision_id
  );
$$;

revoke all on function private.enqueue_knowledge_index(uuid, text, uuid) from public;

create function private.index_published_content()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.published_revision_id is not null
     and (tg_op = 'INSERT' or new.published_revision_id is distinct from old.published_revision_id) then
    perform private.enqueue_knowledge_index(new.tenant_id, 'content', new.published_revision_id);
  end if;
  return null;
end;
$$;

create function private.index_published_tour()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.published_revision_id is not null
     and (tg_op = 'INSERT' or new.published_revision_id is distinct from old.published_revision_id) then
    perform private.enqueue_knowledge_index(new.tenant_id, 'tour', new.published_revision_id);
  end if;
  return null;
end;
$$;

-- In the same transaction as the publication (enqueue_job is idempotent by revision).
create trigger content_items_index_knowledge
  after insert or update of published_revision_id on public.content_items
  for each row execute function private.index_published_content();

create trigger tours_index_knowledge
  after insert or update of published_revision_id on public.tours
  for each row execute function private.index_published_tour();

revoke all on function private.index_published_content() from public;
revoke all on function private.index_published_tour() from public;

-- ── worker_api: what to index, and storing it, under the job's lease ───────

-- Everything the indexer needs about the job's revision, or {"status": "not_found"}.
create function worker_api.knowledge_source(p_job_id uuid, p_fencing_token bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_result jsonb;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'knowledge.index' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;

  if v_job.subject_type = 'content_revision' then
    select jsonb_build_object(
      'status', 'ok',
      'source', 'content',
      'kind', i.kind,
      'slug', i.slug,
      'revisionNo', r.revision_no,
      'title', r.title,
      'summary', r.summary,
      'body', r.body,
      'timezone', t.timezone,
      'schedule', case when i.kind = 'event'
                    then private.event_schedule_json(r.starts_local, r.ends_local, r.all_day) end,
      'venueTitle', (
        select vr.title from public.content_items vi
        join public.content_revisions vr on vr.id = vi.published_revision_id
        where vi.tenant_id = r.tenant_id and vi.id = r.venue_content_id
      ),
      'document', (
        select jsonb_build_object(
          'prefix', v.tenant_id::text || '/' || v.asset_id::text || '/' || v.version::text || '/',
          'manifest', v.manifest)
        from public.asset_versions v
        where v.tenant_id = r.tenant_id and v.id = r.document_version_id and v.status = 'ready'
      )
    ) into v_result
    from public.content_revisions r
    join public.content_items i on i.tenant_id = r.tenant_id and i.id = r.content_id
    join public.tenants t on t.id = r.tenant_id
    where r.tenant_id = v_job.tenant_id and r.id = v_job.subject_id and r.state = 'sealed';
  elsif v_job.subject_type = 'tour_revision' then
    select jsonb_build_object(
      'status', 'ok',
      'source', 'tour',
      'kind', i.kind,
      'slug', i.slug,
      'revisionNo', r.revision_no,
      'title', coalesce(cr.title, i.slug),
      'manifest', r.manifest
    ) into v_result
    from public.tour_revisions r
    join public.tours tr on tr.tenant_id = r.tenant_id and tr.id = r.tour_id
    join public.content_items i on i.tenant_id = tr.tenant_id and i.id = tr.content_id
    left join public.content_revisions cr on cr.id = i.published_revision_id
    where r.tenant_id = v_job.tenant_id and r.id = v_job.subject_id and r.state = 'sealed';
  end if;

  return coalesce(v_result, jsonb_build_object('status', 'not_found'));
end;
$$;

-- Replaces every chunk of the job's revision at once (a search sees the old or the new set,
-- never a mix). p_chunks: [{chunkNo, heading, body, pageFrom, pageTo, sceneId, hotspotId,
-- sha256}], at most 5000 and 4 000 000 characters.
create function worker_api.store_knowledge_chunks(
  p_job_id uuid,
  p_fencing_token bigint,
  p_chunker_version integer,
  p_title text,
  p_chunks jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_content uuid;
  v_tour uuid;
  v_characters integer;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'knowledge.index' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) > 5000 then
    raise exception 'invalid chunks' using errcode = '23514';
  end if;
  select coalesce(sum(char_length(c ->> 'body')), 0) into v_characters
  from jsonb_array_elements(p_chunks) c;
  if v_characters > 4000000 then
    raise exception 'too much text' using errcode = '23514';
  end if;

  if v_job.subject_type = 'content_revision' then
    select r.content_id into v_content from public.content_revisions r
    where r.tenant_id = v_job.tenant_id and r.id = v_job.subject_id and r.state = 'sealed';
    if v_content is null then
      return 'not_found';
    end if;
    delete from public.knowledge_chunks c where c.content_revision_id = v_job.subject_id;
  elsif v_job.subject_type = 'tour_revision' then
    select r.tour_id into v_tour from public.tour_revisions r
    where r.tenant_id = v_job.tenant_id and r.id = v_job.subject_id and r.state = 'sealed';
    if v_tour is null then
      return 'not_found';
    end if;
    delete from public.knowledge_chunks c where c.tour_revision_id = v_job.subject_id;
  else
    return 'not_found';
  end if;

  insert into public.knowledge_chunks (
    tenant_id, content_id, content_revision_id, tour_id, tour_revision_id, chunker_version,
    chunk_no, title, heading, body, page_from, page_to, scene_id, hotspot_id, sha256
  )
  select
    v_job.tenant_id, v_content, case when v_content is not null then v_job.subject_id end,
    v_tour, case when v_tour is not null then v_job.subject_id end, p_chunker_version,
    (c ->> 'chunkNo')::integer, left(p_title, 160), nullif(c ->> 'heading', ''), c ->> 'body',
    (c ->> 'pageFrom')::integer, (c ->> 'pageTo')::integer,
    (c ->> 'sceneId')::uuid, (c ->> 'hotspotId')::uuid, c ->> 'sha256'
  from jsonb_array_elements(p_chunks) c;

  delete from public.knowledge_indexed_revisions k
  where k.content_revision_id = v_job.subject_id or k.tour_revision_id = v_job.subject_id;
  insert into public.knowledge_indexed_revisions (
    tenant_id, content_revision_id, tour_revision_id, chunker_version, chunks, characters, job_id
  )
  values (
    v_job.tenant_id, case when v_content is not null then v_job.subject_id end,
    case when v_tour is not null then v_job.subject_id end, p_chunker_version,
    jsonb_array_length(p_chunks), v_characters, v_job.id
  );
  return 'stored';
end;
$$;

revoke all on function worker_api.knowledge_source(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function worker_api.store_knowledge_chunks(uuid, bigint, integer, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function worker_api.knowledge_source(uuid, bigint) to rikuy_worker;
grant execute on function worker_api.store_knowledge_chunks(uuid, bigint, integer, text, jsonb) to rikuy_worker;

-- ── Search ──────────────────────────────────────────────────────────────────

-- The question's content words (accents and stop words removed), at most 32.
create function private.knowledge_terms(p_query text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select coalesce(array(
    select lexeme
    from unnest(tsvector_to_array(
      to_tsvector('spanish'::regconfig,
        private.unaccent_text(regexp_replace(left(coalesce(p_query, ''), 500), '[\\'':&|!()<>*]', ' ', 'g')))
    )) as lexeme
    where char_length(lexeme) between 2 and 40
    order by lexeme
    limit 32
  ), array[]::text[]);
$$;

revoke all on function private.knowledge_terms(text) from public;

-- Fragments of what the municipality has published NOW, best first. The current pointer of
-- each chunk's content (or tour, and its content) is checked here, at query time.
create function private.search_knowledge(p_tenant_id uuid, p_query text, p_limit integer)
returns table (
  chunk_id        uuid,
  source          text,
  source_id       uuid,
  source_version  integer,
  kind            public.content_kind,
  slug            text,
  title           text,
  heading         text,
  body            text,
  page_from       integer,
  page_to         integer,
  scene_id        uuid,
  hotspot_id      uuid,
  ended           boolean,
  score           real
)
language sql
stable
security definer
set search_path = ''
as $$
  with terms as (
    select t.terms,
           array_to_string(array(select quote_literal(x) from unnest(t.terms) x), ' | ')::tsquery as q
    from (select private.knowledge_terms(p_query) as terms) t
    where cardinality(t.terms) > 0
  ),
  visible as (
    select c.id, 'content'::text as source, i.id as source_id, r.revision_no, i.kind, i.slug,
           c.title, c.heading, c.body, c.page_from, c.page_to, c.scene_id, c.hotspot_id,
           i.kind = 'event' and coalesce(private.event_ends_at(r.ends_local, r.all_day, tn.timezone) <= now(), false) as ended,
           c.search
    from public.knowledge_chunks c
    join public.content_items i
      on i.tenant_id = c.tenant_id and i.id = c.content_id and i.published_revision_id = c.content_revision_id
    join public.content_revisions r on r.id = c.content_revision_id
    join public.tenants tn on tn.id = c.tenant_id
    where c.tenant_id = p_tenant_id
    union all
    select c.id, 'tour'::text, t.id, tr.revision_no, i.kind, i.slug,
           c.title, c.heading, c.body, c.page_from, c.page_to, c.scene_id, c.hotspot_id,
           i.kind = 'event' and coalesce(private.event_ends_at(cr.ends_local, cr.all_day, tn.timezone) <= now(), false),
           c.search
    from public.knowledge_chunks c
    join public.tours t
      on t.tenant_id = c.tenant_id and t.id = c.tour_id and t.published_revision_id = c.tour_revision_id
    join public.tour_revisions tr on tr.id = c.tour_revision_id
    join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
    join public.content_revisions cr on cr.id = i.published_revision_id and cr.state = 'sealed'
    join public.tenants tn on tn.id = c.tenant_id
    where c.tenant_id = p_tenant_id
  )
  select v.id, v.source, v.source_id, v.revision_no, v.kind, v.slug, v.title, v.heading, v.body,
         v.page_from, v.page_to, v.scene_id, v.hotspot_id, v.ended,
         (
           -- How many of the question's words the fragment has, then how densely.
           (select count(*) from unnest(terms.terms) term where v.search @@ quote_literal(term)::tsquery)::real
           + ts_rank_cd(v.search, terms.q, 32)
         ) as score
  from visible v
  cross join terms
  where v.search @@ terms.q
  order by score desc, v.id
  limit greatest(1, least(coalesce(p_limit, 8), 20));
$$;

revoke all on function private.search_knowledge(uuid, text, integer) from public;

-- The assistant (ADR-036 role): only municipalities online.
create function ai_api.search_knowledge(p_tenant_id uuid, p_query text, p_limit integer default 8)
returns table (
  chunk_id        uuid,
  source          text,
  source_id       uuid,
  source_version  integer,
  kind            public.content_kind,
  slug            text,
  title           text,
  heading         text,
  body            text,
  page_from       integer,
  page_to         integer,
  scene_id        uuid,
  hotspot_id      uuid,
  ended           boolean,
  score           real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.tenants t where t.id = p_tenant_id and t.status = 'active') then
    return;
  end if;
  return query select * from private.search_knowledge(p_tenant_id, p_query, p_limit);
end;
$$;

-- «Probar la búsqueda» in the panel: exactly what the assistant would find (any member).
create function public.search_tenant_knowledge(p_tenant_id uuid, p_query text, p_limit integer default 8)
returns table (
  chunk_id        uuid,
  source          text,
  source_id       uuid,
  source_version  integer,
  kind            public.content_kind,
  slug            text,
  title           text,
  heading         text,
  body            text,
  page_from       integer,
  page_to         integer,
  scene_id        uuid,
  hotspot_id      uuid,
  ended           boolean,
  score           real
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  return query select * from private.search_knowledge(p_tenant_id, p_query, p_limit);
end;
$$;

-- What the assistant knows, source by source: every published content (destinations,
-- events, knowledge) and tour, and whether its current revision is indexed.
create function public.knowledge_index_status(p_tenant_id uuid)
returns table (
  source          text,
  source_id       uuid,
  kind            public.content_kind,
  slug            text,
  title           text,
  revision_no     integer,
  published_at    timestamptz,
  chunks          integer,
  indexed_at      timestamptz,
  job_status      public.job_status,
  job_error_code  text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]
  ) then
    raise exception 'not a member of this tenant' using errcode = '42501';
  end if;
  return query
  select 'content'::text, i.id, i.kind, i.slug, r.title, r.revision_no, i.published_at,
         k.chunks, k.indexed_at, j.status, j.last_error_code
  from public.content_items i
  join public.content_revisions r on r.id = i.published_revision_id
  left join public.knowledge_indexed_revisions k on k.content_revision_id = r.id
  left join public.background_jobs j
    on j.tenant_id = i.tenant_id and j.kind = 'knowledge.index'
   and j.logical_key = 'content_revision:' || r.id::text || ':1'
  where i.tenant_id = p_tenant_id
  union all
  select 'tour'::text, t.id, i.kind, i.slug, cr.title, tr.revision_no, t.published_at,
         k.chunks, k.indexed_at, j.status, j.last_error_code
  from public.tours t
  join public.tour_revisions tr on tr.id = t.published_revision_id
  join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
  join public.content_revisions cr on cr.id = coalesce(i.published_revision_id, i.draft_revision_id)
  left join public.knowledge_indexed_revisions k on k.tour_revision_id = tr.id
  left join public.background_jobs j
    on j.tenant_id = t.tenant_id and j.kind = 'knowledge.index'
   and j.logical_key = 'tour_revision:' || tr.id::text || ':1'
  where t.tenant_id = p_tenant_id
  order by 3, 5;
end;
$$;

revoke all on function ai_api.search_knowledge(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.search_tenant_knowledge(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.knowledge_index_status(uuid) from public, anon, authenticated;
grant execute on function ai_api.search_knowledge(uuid, text, integer) to rikuy_ai;
grant execute on function public.search_tenant_knowledge(uuid, text, integer) to authenticated;
grant execute on function public.knowledge_index_status(uuid) to authenticated;

-- ── Backfill: what is already published is indexed by the runner ──────────

select private.enqueue_knowledge_index(i.tenant_id, 'content', i.published_revision_id)
from public.content_items i
where i.published_revision_id is not null;

select private.enqueue_knowledge_index(t.tenant_id, 'tour', t.published_revision_id)
from public.tours t
where t.published_revision_id is not null;
