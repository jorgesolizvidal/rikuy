-- P5 · Paso 7 — Copilot V1 (read/analyze) and V2 (proposals with a diff that save a draft)
-- (ADR-042, concretes ADR-008). Expand only.
--
-- - copilot_content_review: what is incomplete in the municipality's content, computed by
--   fixed rules (never by the model), for any member.
-- - copilot_proposals: what the model proposed for the texts of one destination, event or
--   tour scene, with the base it was made on (revision + edit number), the values before
--   and after, its sources and an expiry (30 days). Editors and above create, list, accept
--   (only the fields they tick) and reject them. Accepting re-checks the role and the base
--   and saves a DRAFT through the same RPCs as the editors; nothing is ever published.
--   A proposal made on a base that changed since is refused (PT409, hint «stale»).
-- - The conversation is never stored; a proposal keeps no prompt and no model reasoning.

-- ── Table ─────────────────────────────────────────────────────────────────

create table public.copilot_proposals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  -- content: a destination or an event · scene: one scene of the tour of a destination or event
  target_kind      text not null,
  content_id       uuid not null,
  tour_id          uuid,
  scene_id         uuid,
  -- The revision the proposal was made on: the open draft (with its edit number), or the
  -- published revision when there was no draft (base_edit null). Not a foreign key: a draft
  -- that is discarded or published simply makes the proposal stale.
  base_revision_id uuid not null,
  base_edit        integer,
  -- {"title": {"from": …, "to": …}, …}: only the fields that change.
  changes          jsonb not null,
  -- What the model read to write it: [{"label": "Destino", "title": "…"}], at most 8.
  sources          jsonb not null default '[]'::jsonb,
  -- The staff's request in their words (data, never instructions), at most 300 characters.
  instruction      text not null default '',
  ai_request_id    uuid not null,
  status           text not null default 'pending',
  accepted_fields  text[],
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '30 days',
  decided_by       uuid references auth.users (id) on delete set null,
  decided_at       timestamptz,

  constraint copilot_proposals_tenant_id_id_key unique (tenant_id, id),
  constraint copilot_proposals_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete cascade,
  constraint copilot_proposals_tour_fkey foreign key (tenant_id, tour_id)
    references public.tours (tenant_id, id) on delete cascade,
  constraint copilot_proposals_request_fkey foreign key (tenant_id, ai_request_id)
    references public.ai_requests (tenant_id, id) on delete cascade,
  constraint copilot_proposals_target check (
    (target_kind = 'content' and tour_id is null and scene_id is null)
    or (target_kind = 'scene' and tour_id is not null and scene_id is not null)
  ),
  constraint copilot_proposals_base_edit check (base_edit is null or base_edit >= 1),
  constraint copilot_proposals_changes check (
    jsonb_typeof(changes) = 'object' and changes <> '{}'::jsonb and octet_length(changes::text) <= 220000
  ),
  constraint copilot_proposals_sources check (
    jsonb_typeof(sources) = 'array' and jsonb_array_length(sources) <= 8
  ),
  constraint copilot_proposals_instruction check (
    char_length(instruction) <= 300 and instruction !~ '[[:cntrl:]]'
  ),
  constraint copilot_proposals_status check (
    (status = 'pending' and accepted_fields is null and decided_at is null)
    or (status = 'accepted' and cardinality(accepted_fields) >= 1 and decided_at is not null)
    or (status = 'rejected' and accepted_fields is null and decided_at is not null)
  ),
  constraint copilot_proposals_expiry check (expires_at > created_at)
);

create index copilot_proposals_tenant_status_idx
  on public.copilot_proposals (tenant_id, status, created_at desc);
create index copilot_proposals_content_idx on public.copilot_proposals (tenant_id, content_id);
create index copilot_proposals_request_idx on public.copilot_proposals (tenant_id, ai_request_id);
create index copilot_proposals_expiry_idx on public.copilot_proposals (expires_at);

alter table public.copilot_proposals enable row level security;
-- No policies and no grants: every read and write goes through the RPCs below.
revoke all on public.copilot_proposals from public, anon, authenticated;

create trigger copilot_proposals_tenant_immutable
  before update on public.copilot_proposals
  for each row execute function private.forbid_tenant_change();

-- ── Helpers ───────────────────────────────────────────────────────────────

-- Characters of text in a rich text AST (every "text" leaf).
create function private.rich_text_length(p jsonb)
returns integer
language sql
immutable
set search_path = ''
as $$
  select coalesce(sum(char_length(t #>> '{}')), 0)::integer
  from jsonb_path_query(coalesce(p, '[]'::jsonb), 'strict $.**.text') t;
$$;

revoke all on function private.rich_text_length(jsonb) from public;

-- Is the proposal's base still what an editor would edit now? (open draft with the same
-- edit number, or no draft and the same published revision)
create function private.copilot_base_is_current(
  p_target_kind text,
  p_tenant_id uuid,
  p_content_id uuid,
  p_tour_id uuid,
  p_base_revision_id uuid,
  p_base_edit integer
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_target_kind
    when 'content' then exists (
      select 1 from public.content_items i
      left join public.content_revisions d on d.id = i.draft_revision_id
      where i.tenant_id = p_tenant_id and i.id = p_content_id
        and (
          (p_base_edit is not null and i.draft_revision_id = p_base_revision_id and d.edit_count = p_base_edit)
          or (p_base_edit is null and i.draft_revision_id is null and i.published_revision_id = p_base_revision_id)
        ))
    when 'scene' then exists (
      select 1 from public.tours t
      left join public.tour_revisions d on d.id = t.draft_revision_id
      where t.tenant_id = p_tenant_id and t.id = p_tour_id
        and (
          (p_base_edit is not null and t.draft_revision_id = p_base_revision_id and d.edit_count = p_base_edit)
          or (p_base_edit is null and t.draft_revision_id is null and t.published_revision_id = p_base_revision_id)
        ))
    else false
  end;
$$;

revoke all on function private.copilot_base_is_current(text, uuid, uuid, uuid, uuid, integer) from public;

-- The revision an editor works on now: the open draft, else the published one.
create function private.content_working_revision(p_content_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(i.draft_revision_id, i.published_revision_id)
  from public.content_items i where i.id = p_content_id;
$$;

revoke all on function private.content_working_revision(uuid) from public;

create function private.tour_working_revision(p_tour_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(t.draft_revision_id, t.published_revision_id)
  from public.tours t where t.id = p_tour_id;
$$;

revoke all on function private.tour_working_revision(uuid) from public;

-- ── V1: what is incomplete (fixed rules) ─────────────────────────────────

create function public.copilot_content_review(p_tenant_id uuid)
returns table (
  kind text,
  content_id uuid,
  slug text,
  tour_id uuid,
  scene_id uuid,
  title text,
  scene_title text,
  status text,
  issues text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]);

  return query
  with items as (
    select i.id, i.kind::text as kind, i.slug,
           i.published_revision_id is not null as published,
           i.draft_revision_id is not null as has_draft,
           r.id as revision_id, r.title, r.summary, r.body, r.latitude,
           r.starts_local, r.opening_hours,
           private.rich_text_length(r.body) as body_length,
           exists (select 1 from public.media_references m where m.revision_id = r.id and m.purpose = 'cover') as has_cover,
           exists (
             select 1 from public.tours t
             where t.tenant_id = i.tenant_id and t.content_id = i.id and t.published_revision_id is not null
           ) as has_tour,
           i.kind = 'event' and r.starts_local is not null
             and private.event_ends_at(r.ends_local, r.all_day, tn.timezone) < now() as ended
    from public.content_items i
    join public.tenants tn on tn.id = i.tenant_id
    join public.content_revisions r on r.id = coalesce(i.draft_revision_id, i.published_revision_id)
    where i.tenant_id = p_tenant_id and i.kind in ('destination', 'event')
  ),
  item_issues as (
    select it.*, array_remove(array[
      case when not it.published then 'never_published' end,
      case when it.published and it.has_draft then 'unpublished_changes' end,
      case when it.summary = '' then 'summary_missing'
           when char_length(it.summary) < 60 then 'summary_short' end,
      case when it.body_length = 0 then 'body_missing'
           when it.body_length < 300 then 'body_short' end,
      case when not it.has_cover then 'cover_missing' end,
      case when it.latitude is null then 'location_missing' end,
      case when it.kind = 'destination' and it.opening_hours is null then 'hours_missing' end,
      case when it.kind = 'event' and it.starts_local is null then 'schedule_missing' end,
      case when it.kind = 'destination' and not it.has_tour then 'tour_missing' end
    ], null) as found
    from items it
    where not it.ended
  )
  select ii.kind, ii.id, ii.slug, null::uuid, null::uuid, ii.title, null::text,
         case when not ii.published then 'draft' when ii.has_draft then 'changed' else 'published' end,
         ii.found
  from item_issues ii
  where cardinality(ii.found) > 0
  union all
  -- Scenes without a description: the tour guide has nothing to tell (ADR-040).
  select i.kind::text, i.id, i.slug, t.id, s.scene_id, i_rev.title, s.title,
         case when t.published_revision_id is null then 'draft'
              when t.draft_revision_id is not null then 'changed' else 'published' end,
         array['scene_description_missing']
  from public.tours t
  join public.content_items i on i.tenant_id = t.tenant_id and i.id = t.content_id
  join public.content_revisions i_rev on i_rev.id = coalesce(i.draft_revision_id, i.published_revision_id)
  join public.tour_scenes s on s.tour_revision_id = coalesce(t.draft_revision_id, t.published_revision_id)
  where t.tenant_id = p_tenant_id and s.description = ''
  order by 1, 6, 7 nulls first;
end;
$$;

revoke all on function public.copilot_content_review(uuid) from public, anon, authenticated;
grant execute on function public.copilot_content_review(uuid) to authenticated;

-- The authorized snapshot the Copilot's model reads (V1): every destination and event of
-- the municipality as an editor sees it (drafts included), with what the platform knows.
create function public.copilot_snapshot(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]);

  select jsonb_build_object(
    'timezone', tn.timezone,
    'items', coalesce((
      select jsonb_agg(x.item order by x.kind, x.title)
      from (
        select i.kind::text as kind, r.title,
               jsonb_build_object(
                 'kind', i.kind,
                 'contentId', i.id,
                 'slug', i.slug,
                 'title', r.title,
                 'summary', r.summary,
                 'status', case when i.published_revision_id is null then 'draft'
                                when i.draft_revision_id is not null then 'changed' else 'published' end,
                 'schedule', case when i.kind = 'event' and r.starts_local is not null
                                  then private.event_schedule_json(r.starts_local, r.ends_local, r.all_day) end,
                 'ended', i.kind = 'event' and r.starts_local is not null
                          and private.event_ends_at(r.ends_local, r.all_day, tn.timezone) < now(),
                 'tour', (
                   select jsonb_build_object(
                     'tourId', t.id,
                     'status', case when t.published_revision_id is null then 'draft'
                                    when t.draft_revision_id is not null then 'changed' else 'published' end,
                     'scenes', (select count(*) from public.tour_scenes s
                                where s.tour_revision_id = coalesce(t.draft_revision_id, t.published_revision_id)))
                   from public.tours t where t.tenant_id = i.tenant_id and t.content_id = i.id)
               ) as item
        from public.content_items i
        join public.content_revisions r on r.id = coalesce(i.draft_revision_id, i.published_revision_id)
        where i.tenant_id = p_tenant_id and i.kind in ('destination', 'event')
        order by i.updated_at desc
        limit 200
      ) x
    ), '[]'::jsonb)
  ) into v_result
  from public.tenants tn where tn.id = p_tenant_id;
  return v_result;
end;
$$;

revoke all on function public.copilot_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.copilot_snapshot(uuid) to authenticated;

-- ── V2: proposals ─────────────────────────────────────────────────────────

-- A proposal: on the CURRENT base, only allowed fields with valid values that change
-- something, tied to a copilot request of this same person in this municipality.
create function public.create_copilot_proposal(
  p_tenant_id uuid,
  p_target jsonb,
  p_base_revision_id uuid,
  p_base_edit integer,
  p_changes jsonb,
  p_sources jsonb,
  p_instruction text,
  p_ai_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_content uuid;
  v_tour uuid;
  v_scene uuid;
  v_before jsonb;
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_value jsonb;
  v_source jsonb;
  v_id uuid;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  if p_target is null or jsonb_typeof(p_target) <> 'object' then
    raise exception 'invalid target' using errcode = '23514';
  end if;
  if private.has_exact_keys(p_target, array['contentId']) then
    v_kind := 'content';
    v_content := (p_target ->> 'contentId')::uuid;
    if not exists (
      select 1 from public.content_items i
      where i.tenant_id = p_tenant_id and i.id = v_content and i.kind in ('destination', 'event')
    ) then
      raise exception 'content not found' using errcode = 'PT404';
    end if;
  elsif private.has_exact_keys(p_target, array['tourId', 'sceneId']) then
    v_kind := 'scene';
    v_tour := (p_target ->> 'tourId')::uuid;
    v_scene := (p_target ->> 'sceneId')::uuid;
    select t.content_id into v_content from public.tours t where t.tenant_id = p_tenant_id and t.id = v_tour;
    if not found then
      raise exception 'tour not found' using errcode = 'PT404';
    end if;
  else
    raise exception 'invalid target' using errcode = '23514';
  end if;

  if not private.copilot_base_is_current(v_kind, p_tenant_id, v_content, v_tour, p_base_revision_id, p_base_edit) then
    raise exception 'the content changed since the proposal was made' using errcode = 'PT409', hint = 'stale';
  end if;

  -- «from»: read from the base itself, never from the caller.
  if v_kind = 'content' then
    select jsonb_build_object('title', r.title, 'summary', r.summary, 'body', r.body) into v_before
    from public.content_revisions r where r.id = p_base_revision_id;
  else
    select jsonb_build_object('title', s.title, 'description', s.description) into v_before
    from public.tour_scenes s
    where s.tenant_id = p_tenant_id and s.tour_revision_id = p_base_revision_id and s.scene_id = v_scene;
    if v_before is null then
      raise exception 'scene not found' using errcode = 'PT404';
    end if;
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb
     or not private.has_exact_keys(
       p_changes, '{}',
       case v_kind when 'content' then array['title', 'summary', 'body'] else array['title', 'description'] end
     ) then
    raise exception 'invalid changes' using errcode = '23514';
  end if;
  for v_key, v_value in select key, value from jsonb_each(p_changes) loop
    if not (case v_key
      when 'title' then private.is_plain_line(v_value, 1, 120)
      when 'summary' then private.is_plain_line(v_value, 0, 300)
      when 'body' then private.is_valid_rich_text(v_value)
      when 'description' then private.is_plain_line(v_value, 0, 1000)
      else false
    end) then
      raise exception 'invalid value for %', v_key using errcode = '23514', hint = v_key;
    end if;
    if v_value is distinct from v_before -> v_key then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_before -> v_key, 'to', v_value));
    end if;
  end loop;
  if v_changes = '{}'::jsonb then
    raise exception 'the proposal changes nothing' using errcode = '23514', hint = 'unchanged';
  end if;

  if p_sources is null or jsonb_typeof(p_sources) <> 'array' or jsonb_array_length(p_sources) > 8 then
    raise exception 'invalid sources' using errcode = '23514';
  end if;
  for v_source in select value from jsonb_array_elements(p_sources) loop
    if not (
      private.has_exact_keys(v_source, array['label', 'title'])
      and private.is_plain_line(v_source -> 'label', 1, 40)
      and private.is_plain_line(v_source -> 'title', 1, 200)
    ) then
      raise exception 'invalid sources' using errcode = '23514';
    end if;
  end loop;

  if p_instruction is null or char_length(p_instruction) > 300 or p_instruction ~ '[[:cntrl:]]' then
    raise exception 'invalid instruction' using errcode = '23514';
  end if;

  -- The model's answer behind it: a copilot request of this person, here, in the last hour.
  if not exists (
    select 1 from public.ai_requests a
    where a.tenant_id = p_tenant_id and a.id = p_ai_request_id
      and a.profile = 'copilot' and a.status = 'completed'
      and a.actor_id = (select auth.uid())
      and a.created_at > now() - interval '1 hour'
  ) then
    raise exception 'no copilot request behind this proposal' using errcode = '23514', hint = 'request';
  end if;

  insert into public.copilot_proposals (
    tenant_id, target_kind, content_id, tour_id, scene_id, base_revision_id, base_edit,
    changes, sources, instruction, ai_request_id, created_by
  ) values (
    p_tenant_id, v_kind, v_content, v_tour, v_scene, p_base_revision_id, p_base_edit,
    v_changes, p_sources, btrim(p_instruction), p_ai_request_id, (select auth.uid())
  ) returning id into v_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'copilot.proposal_created', 'copilot_proposal', v_id, null, 'success',
          jsonb_build_object('target', v_kind, 'content_id', v_content, 'scene_id', v_scene,
                             'fields', (select jsonb_agg(k order by k) from jsonb_object_keys(v_changes) k)));

  return v_id;
end;
$$;

revoke all on function public.create_copilot_proposal(uuid, jsonb, uuid, integer, jsonb, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.create_copilot_proposal(uuid, jsonb, uuid, integer, jsonb, jsonb, text, uuid) to authenticated;

-- The proposals of the last 30 days (they are deleted when they expire).
create function public.list_copilot_proposals(p_tenant_id uuid)
returns table (
  id uuid,
  target_kind text,
  content_kind text,
  content_id uuid,
  tour_id uuid,
  scene_id uuid,
  title text,
  scene_title text,
  fields text[],
  instruction text,
  status text,
  stale boolean,
  accepted_fields text[],
  created_at timestamptz,
  expires_at timestamptz,
  decided_at timestamptz,
  mine boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  return query
  select p.id, p.target_kind, i.kind::text, p.content_id, p.tour_id, p.scene_id,
         r.title,
         (select s.title from public.tour_scenes s
          where s.tour_revision_id = private.tour_working_revision(p.tour_id) and s.scene_id = p.scene_id),
         (select array_agg(k order by k) from jsonb_object_keys(p.changes) k),
         p.instruction,
         case when p.status = 'pending' and p.expires_at <= now() then 'expired' else p.status end,
         p.status = 'pending' and not private.copilot_base_is_current(
           p.target_kind, p.tenant_id, p.content_id, p.tour_id, p.base_revision_id, p.base_edit),
         p.accepted_fields, p.created_at, p.expires_at, p.decided_at,
         p.created_by = (select auth.uid())
  from public.copilot_proposals p
  join public.content_items i on i.tenant_id = p.tenant_id and i.id = p.content_id
  left join public.content_revisions r on r.id = private.content_working_revision(p.content_id)
  where p.tenant_id = p_tenant_id
  order by p.created_at desc
  limit 200;
end;
$$;

revoke all on function public.list_copilot_proposals(uuid) from public, anon, authenticated;
grant execute on function public.list_copilot_proposals(uuid) to authenticated;

create function public.copilot_proposal(p_tenant_id uuid, p_proposal_id uuid)
returns table (
  id uuid,
  target_kind text,
  content_kind text,
  content_id uuid,
  tour_id uuid,
  scene_id uuid,
  title text,
  scene_title text,
  changes jsonb,
  sources jsonb,
  instruction text,
  status text,
  stale boolean,
  accepted_fields text[],
  created_at timestamptz,
  expires_at timestamptz,
  decided_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  return query
  select p.id, p.target_kind, i.kind::text, p.content_id, p.tour_id, p.scene_id,
         r.title,
         (select s.title from public.tour_scenes s
          where s.tour_revision_id = private.tour_working_revision(p.tour_id) and s.scene_id = p.scene_id),
         p.changes, p.sources, p.instruction,
         case when p.status = 'pending' and p.expires_at <= now() then 'expired' else p.status end,
         p.status = 'pending' and not private.copilot_base_is_current(
           p.target_kind, p.tenant_id, p.content_id, p.tour_id, p.base_revision_id, p.base_edit),
         p.accepted_fields, p.created_at, p.expires_at, p.decided_at
  from public.copilot_proposals p
  join public.content_items i on i.tenant_id = p.tenant_id and i.id = p.content_id
  left join public.content_revisions r on r.id = private.content_working_revision(p.content_id)
  where p.tenant_id = p_tenant_id and p.id = p_proposal_id;
end;
$$;

revoke all on function public.copilot_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.copilot_proposal(uuid, uuid) to authenticated;

-- Accepting saves a DRAFT with the ticked fields, through the editors' own RPCs (same
-- validation, same role checks, same optimistic concurrency). Never publishes.
create function public.accept_copilot_proposal(p_tenant_id uuid, p_proposal_id uuid, p_fields text[])
returns table (revision_no integer, edit_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_proposal public.copilot_proposals;
  v_field text;
  v_document jsonb;
  v_scene_changes jsonb := '{}'::jsonb;
  v_revision_no integer;
  v_edit integer;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select p.* into v_proposal from public.copilot_proposals p
  where p.tenant_id = p_tenant_id and p.id = p_proposal_id
  for update;
  if not found then
    raise exception 'proposal not found' using errcode = 'PT404';
  end if;
  if v_proposal.status <> 'pending' then
    raise exception 'the proposal was already decided' using errcode = 'PT409', hint = 'decided';
  end if;
  if v_proposal.expires_at <= now() then
    raise exception 'the proposal expired' using errcode = 'PT409', hint = 'expired';
  end if;
  if p_fields is null or cardinality(p_fields) = 0
     or exists (select 1 from unnest(p_fields) f where not v_proposal.changes ? f)
     or cardinality(p_fields) <> (select count(distinct f) from unnest(p_fields) f) then
    raise exception 'invalid fields' using errcode = '23514';
  end if;
  if not private.copilot_base_is_current(
    v_proposal.target_kind, p_tenant_id, v_proposal.content_id, v_proposal.tour_id,
    v_proposal.base_revision_id, v_proposal.base_edit
  ) then
    raise exception 'the content changed since the proposal was made' using errcode = 'PT409', hint = 'stale';
  end if;

  if v_proposal.target_kind = 'content' then
    v_document := private.revision_document(v_proposal.base_revision_id);
    foreach v_field in array p_fields loop
      v_document := v_document || jsonb_build_object(v_field, v_proposal.changes #> array[v_field, 'to']);
    end loop;
    select s.revision_no, s.edit_count into v_revision_no, v_edit
    from public.save_content_draft(p_tenant_id, v_proposal.content_id, v_document, v_proposal.base_edit) s;
  else
    foreach v_field in array p_fields loop
      v_scene_changes := v_scene_changes || jsonb_build_object(v_field, v_proposal.changes #> array[v_field, 'to']);
    end loop;
    perform public.update_tour_scene(
      p_tenant_id, v_proposal.tour_id, v_proposal.base_edit, v_proposal.scene_id, v_scene_changes);
    select r.revision_no, r.edit_count into v_revision_no, v_edit
    from public.tours t join public.tour_revisions r on r.id = t.draft_revision_id
    where t.id = v_proposal.tour_id;
  end if;

  update public.copilot_proposals p
  set status = 'accepted', accepted_fields = p_fields, decided_by = (select auth.uid()), decided_at = now()
  where p.id = v_proposal.id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'copilot.proposal_accepted', 'copilot_proposal', v_proposal.id,
          v_revision_no, 'success',
          jsonb_build_object('target', v_proposal.target_kind, 'content_id', v_proposal.content_id,
                             'scene_id', v_proposal.scene_id, 'fields', to_jsonb(p_fields)));

  return query select v_revision_no, v_edit;
end;
$$;

revoke all on function public.accept_copilot_proposal(uuid, uuid, text[]) from public, anon, authenticated;
grant execute on function public.accept_copilot_proposal(uuid, uuid, text[]) to authenticated;

create function public.reject_copilot_proposal(p_tenant_id uuid, p_proposal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);

  select p.status into v_status from public.copilot_proposals p
  where p.tenant_id = p_tenant_id and p.id = p_proposal_id
  for update;
  if not found then
    raise exception 'proposal not found' using errcode = 'PT404';
  end if;
  if v_status <> 'pending' then
    raise exception 'the proposal was already decided' using errcode = 'PT409', hint = 'decided';
  end if;

  update public.copilot_proposals p
  set status = 'rejected', decided_by = (select auth.uid()), decided_at = now()
  where p.id = p_proposal_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'copilot.proposal_rejected', 'copilot_proposal', p_proposal_id,
          null, 'success', '{}'::jsonb);
end;
$$;

revoke all on function public.reject_copilot_proposal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reject_copilot_proposal(uuid, uuid) to authenticated;

-- ── Retention: a proposal lives 30 days (ADR-042); the audit keeps what was decided ──

create function private.delete_expired_copilot_proposals()
returns integer
language sql
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.copilot_proposals p where p.expires_at <= now() returning 1
  )
  select count(*)::integer from gone;
$$;

revoke all on function private.delete_expired_copilot_proposals() from public;

select cron.schedule(
  'rikuy-expire-copilot-proposals',
  '47 7 * * *',
  $$select private.delete_expired_copilot_proposals()$$
);
