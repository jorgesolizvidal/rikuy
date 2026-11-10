-- C0 · Paso 2, corrección — a new poster reaches visitors when the tour is published again
-- (ADR-048, nota de la corrección).
--
-- Until now every poster of a model version was stored as `model/poster.webp`. The public
-- copy of that path is cached for a year and the tour publication skips versions that are
-- already public, so a new poster (a photo or another capture) never reached a published
-- tour, even after publishing it again. Now:
--
-- - each poster has its own name (`poster-<8 hex>.webp`); `poster.webp` stays valid for the
--   posters saved before;
-- - `change_model_poster` records it and, in the same transaction, opens a draft in each
--   tour whose working revision is the published one that uses this version, so the tour
--   can be published again with the new image (tours with a draft get it when published);
-- - `media_publish_version` measures the version again when it was already public: the
--   publication copies the new poster to the public bucket.
--
-- Only expand: `set_model_poster` stays for the web that is still deployed.

create or replace function private.is_valid_model_poster(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(p) = 'object'
    and not exists (
      select 1 from jsonb_object_keys(p) k where k not in ('file', 'width', 'height', 'bytes')
    )
    and (p ->> 'file') ~ '^poster(-[0-9a-f]{8})?\.webp$'
    and (p ->> 'width') ~ '^[0-9]{2,4}$' and (p ->> 'width')::integer between 64 and 2048
    and (p ->> 'height') ~ '^[0-9]{2,4}$' and (p ->> 'height')::integer between 64 and 2048
    and (p ->> 'bytes') ~ '^[0-9]{1,7}$' and (p ->> 'bytes')::integer between 1 and 1048576,
    false
  );
$$;

-- Records the poster the server stored next to the model and prepares the tours that show
-- it. Returns each tour whose working revision uses this version: `opened_draft` when its
-- draft was opened now. Error codes: 42501 forbidden · PT404 unknown · PT409 hint
-- 'not_ready' · 23514 invalid poster.
create function public.change_model_poster(p_tenant_id uuid, p_version_id uuid, p_poster jsonb)
returns table (tour_id uuid, opened_draft boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_version public.asset_versions%rowtype;
  v_tour public.tours%rowtype;
  v_opened boolean;
  v_tours jsonb := '[]'::jsonb;
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[])
     or not exists (
       select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
     ) then
    raise exception 'not allowed to change models of this tenant' using errcode = '42501';
  end if;
  if not private.is_valid_model_poster(p_poster) then
    raise exception 'invalid poster' using errcode = '23514';
  end if;

  select v.* into v_version
  from public.asset_versions v
  join public.assets a on a.tenant_id = v.tenant_id and a.id = v.asset_id
  where v.id = p_version_id and v.tenant_id = p_tenant_id and a.purpose = 'model'
    and a.deleted_at is null
  for update of v;
  if not found then
    raise exception 'model not found' using errcode = 'PT404';
  end if;
  if v_version.status <> 'ready' then
    raise exception 'the model is not ready' using errcode = 'PT409', hint = 'not_ready';
  end if;

  update public.asset_versions v
  set manifest = jsonb_set(v.manifest, '{poster}', p_poster)
  where v.id = v_version.id;

  for v_tour in
    select t.* from public.tours t
    where t.tenant_id = p_tenant_id
      and exists (
        select 1 from private.media_asset_uses(p_tenant_id, v_version.asset_id) u
        where u.tour_id = t.id and u.version_id = v_version.id
          and u.revision_id = coalesce(t.draft_revision_id, t.published_revision_id)
      )
    order by t.created_at
  loop
    v_opened := v_tour.draft_revision_id is null;
    if v_opened then
      -- Same scenes and points, same identifiers: only the poster changes when it is sealed.
      perform private.tour_draft_for_edit(p_tenant_id, v_tour.id, null);
    end if;
    v_tours := v_tours || to_jsonb(v_tour.id);
    tour_id := v_tour.id;
    opened_draft := v_opened;
    return next;
  end loop;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff
  )
  values (
    'tenant', p_tenant_id, (select auth.uid()), 'media.model_poster_set', 'asset_version',
    v_version.id, 'success',
    jsonb_build_object('width', p_poster -> 'width', 'height', p_poster -> 'height', 'tours', v_tours)
  );
end;
$$;

revoke all on function public.change_model_poster(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.change_model_poster(uuid, uuid, jsonb) to authenticated;

-- Publishing an already public version again (a new poster copied to the public bucket)
-- measures it again, so the quota counts the new copy.
create or replace function public.media_publish_version(p_tenant_id uuid, p_asset_id uuid, p_version integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_status public.asset_version_status;
  v_published timestamptz;
begin
  select v.id, v.status, v.published_at into v_id, v_status, v_published
  from public.asset_versions v
  where v.tenant_id = p_tenant_id and v.asset_id = p_asset_id and v.version = p_version
  for update;
  if not found then
    raise exception 'image version not found' using errcode = 'PT404';
  end if;
  if v_status <> 'ready' then
    raise exception 'only ready images can be published' using errcode = 'PT409';
  end if;
  if v_published is null then
    update public.asset_versions v set published_at = now() where v.id = v_id;
  else
    perform private.settle_usage('storage_bytes', v_id, private.measure_version_bytes(v_id), 'settled');
  end if;
end;
$$;
