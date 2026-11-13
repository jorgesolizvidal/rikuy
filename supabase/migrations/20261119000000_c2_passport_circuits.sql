-- C2 · Paso 1 — the circuits of the tourist passport (ADR-056). Expand only.
--
-- A municipality has any number of circuits: a name, a short description, the prize the
-- visitor gets for completing it (in words; redeeming it comes in Paso 3) and its stops, which
-- are published destinations of the same municipality, in a suggested order (the visitor may
-- collect them in any order). Editors build drafts; owners and admins publish, withdraw and
-- change what is published. The portal shows only published circuits, with the stops whose
-- destination is published now.

create table public.passport_circuits (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  slug         text not null,
  name         text not null,
  summary      text not null default '',
  reward       text not null default '',
  status       text not null default 'draft',
  edit_no      integer not null default 1,
  published_at timestamptz,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint passport_circuits_tenant_id_key unique (tenant_id, id),
  constraint passport_circuits_slug_key unique (tenant_id, slug),
  constraint passport_circuits_slug_format check (
    char_length(slug) between 1 and 80 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  constraint passport_circuits_name check (
    char_length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'
  ),
  constraint passport_circuits_summary check (char_length(summary) <= 300 and summary !~ '[[:cntrl:]]'),
  constraint passport_circuits_reward check (char_length(reward) <= 200 and reward !~ '[[:cntrl:]]'),
  constraint passport_circuits_status check (status in ('draft', 'published')),
  constraint passport_circuits_published check ((status = 'published') <= (published_at is not null)),
  constraint passport_circuits_edit_no check (edit_no >= 1)
);

create table public.passport_circuit_stops (
  tenant_id  uuid not null,
  circuit_id uuid not null,
  content_id uuid not null,
  position   integer not null,

  primary key (circuit_id, content_id),
  constraint passport_circuit_stops_position_key unique (circuit_id, position) deferrable initially deferred,
  constraint passport_circuit_stops_position check (position between 1 and 30),
  constraint passport_circuit_stops_circuit_fkey foreign key (tenant_id, circuit_id)
    references public.passport_circuits (tenant_id, id) on delete cascade,
  constraint passport_circuit_stops_content_fkey foreign key (tenant_id, content_id)
    references public.content_items (tenant_id, id) on delete cascade
);

create index passport_circuit_stops_content_idx on public.passport_circuit_stops (tenant_id, content_id);

-- A stop is a destination (it has a fixed place where its stamp can be put all year).
create function private.passport_stop_is_destination()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.content_items i
    where i.tenant_id = new.tenant_id and i.id = new.content_id and i.kind = 'destination'
  ) then
    raise exception 'a stop of a circuit is a destination' using errcode = '23514', hint = 'stop';
  end if;
  return new;
end;
$$;

revoke all on function private.passport_stop_is_destination() from public;

create trigger passport_circuit_stops_destination
  before insert or update on public.passport_circuit_stops
  for each row execute function private.passport_stop_is_destination();

alter table public.passport_circuits enable row level security;
alter table public.passport_circuit_stops enable row level security;
revoke all on public.passport_circuits from public, anon, authenticated, service_role;
revoke all on public.passport_circuit_stops from public, anon, authenticated, service_role;

-- ── The panel ──────────────────────────────────────────────────────────────

-- Every circuit with its stops as editors see them (any member).
create function public.tenant_passport_circuits(p_tenant_id uuid)
returns jsonb
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
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id,
             'slug', c.slug,
             'name', c.name,
             'summary', c.summary,
             'reward', c.reward,
             'status', c.status,
             'editNo', c.edit_no,
             'publishedAt', c.published_at,
             'updatedAt', c.updated_at,
             'stops', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'contentId', s.content_id,
                        'position', s.position,
                        'slug', i.slug,
                        'title', coalesce(pub.title, draft.title),
                        'published', pub.id is not null
                      ) order by s.position)
               from public.passport_circuit_stops s
               join public.content_items i on i.tenant_id = s.tenant_id and i.id = s.content_id
               left join public.content_revisions pub on pub.id = i.published_revision_id
               left join public.content_revisions draft on draft.id = i.draft_revision_id
               where s.circuit_id = c.id
             ), '[]'::jsonb)
           ) order by c.status desc, c.name)
    from public.passport_circuits c
    where c.tenant_id = p_tenant_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.tenant_passport_circuits(uuid) from public, anon, authenticated;
grant execute on function public.tenant_passport_circuits(uuid) to authenticated;

-- A new draft circuit (editors and above).
create function public.create_passport_circuit(p_tenant_id uuid, p_slug text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);
  if exists (select 1 from public.passport_circuits c where c.tenant_id = p_tenant_id and c.slug = p_slug) then
    raise exception 'the address is taken' using errcode = '23505', hint = 'slug';
  end if;
  insert into public.passport_circuits (tenant_id, slug, name, created_by)
  values (p_tenant_id, p_slug, btrim(p_name), (select auth.uid()))
  returning id into v_id;
  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'passport.circuit_created', 'passport_circuit', v_id, 1, 'success',
          jsonb_build_object('slug', p_slug));
  return v_id;
exception
  when check_violation then
    raise exception 'invalid circuit' using errcode = '22023', hint = 'circuit';
end;
$$;

revoke all on function public.create_passport_circuit(uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_passport_circuit(uuid, text, text) to authenticated;

-- Saves name, summary, prize and stops (in their suggested order) with the edit number the
-- person saw. Editors save drafts; what is published only owners and admins change.
create function public.save_passport_circuit(
  p_tenant_id  uuid,
  p_circuit_id uuid,
  p_edit_no    integer,
  p_name       text,
  p_summary    text,
  p_reward     text,
  p_stops      uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_circuit public.passport_circuits;
  v_count integer;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin', 'editor']::public.membership_role[]);
  select * into v_circuit from public.passport_circuits c
  where c.tenant_id = p_tenant_id and c.id = p_circuit_id
  for update;
  if v_circuit.id is null then
    raise exception 'circuit not found' using errcode = 'P0002';
  end if;
  if v_circuit.status = 'published' and not private.has_tenant_role(
    p_tenant_id, array['owner', 'admin']::public.membership_role[]
  ) then
    raise exception 'only owners and admins change a published circuit' using errcode = '42501';
  end if;
  if v_circuit.edit_no is distinct from p_edit_no then
    raise exception 'the circuit changed' using errcode = 'PT409', hint = 'stale';
  end if;
  v_count := coalesce(array_length(p_stops, 1), 0);
  if v_count > 30 or v_count <> (select count(distinct s) from unnest(p_stops) s) or array_position(p_stops, null) is not null then
    raise exception 'invalid stops' using errcode = '22023', hint = 'stops';
  end if;
  if exists (
    select 1 from unnest(p_stops) s
    where not exists (
      select 1 from public.content_items i
      where i.tenant_id = p_tenant_id and i.id = s and i.kind = 'destination'
    )
  ) then
    raise exception 'a stop is not a destination of this municipality' using errcode = '22023', hint = 'stops';
  end if;
  -- A published circuit keeps at least two stops whose destination is published.
  if v_circuit.status = 'published' and (
    select count(*) from unnest(p_stops) s
    join public.content_items i on i.tenant_id = p_tenant_id and i.id = s
    where i.published_revision_id is not null
  ) < 2 then
    raise exception 'a published circuit needs two published destinations' using errcode = '23514', hint = 'incomplete';
  end if;

  update public.passport_circuits c
  set name = btrim(p_name), summary = btrim(coalesce(p_summary, '')), reward = btrim(coalesce(p_reward, '')),
      edit_no = c.edit_no + 1, updated_at = now()
  where c.id = p_circuit_id;
  delete from public.passport_circuit_stops s where s.circuit_id = p_circuit_id;
  insert into public.passport_circuit_stops (tenant_id, circuit_id, content_id, position)
  select p_tenant_id, p_circuit_id, s.id, s.n::integer
  from unnest(p_stops) with ordinality as s (id, n);

  if v_circuit.status = 'published' then
    insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
    values ('tenant', p_tenant_id, (select auth.uid()), 'passport.circuit_changed', 'passport_circuit', p_circuit_id,
            v_circuit.edit_no + 1, 'success', jsonb_build_object('stops', v_count));
  end if;
  return v_circuit.edit_no + 1;
exception
  when check_violation then
    if sqlerrm like 'a published circuit%' then raise; end if;
    raise exception 'invalid circuit' using errcode = '22023', hint = 'circuit';
end;
$$;

revoke all on function public.save_passport_circuit(uuid, uuid, integer, text, text, text, uuid[]) from public, anon, authenticated;
grant execute on function public.save_passport_circuit(uuid, uuid, integer, text, text, text, uuid[]) to authenticated;

-- Publishes a draft (owners and admins): at least two stops whose destination is published.
create function public.publish_passport_circuit(p_tenant_id uuid, p_circuit_id uuid, p_edit_no integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_circuit public.passport_circuits;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  select * into v_circuit from public.passport_circuits c
  where c.tenant_id = p_tenant_id and c.id = p_circuit_id
  for update;
  if v_circuit.id is null then
    raise exception 'circuit not found' using errcode = 'P0002';
  end if;
  if v_circuit.edit_no is distinct from p_edit_no then
    raise exception 'the circuit changed' using errcode = 'PT409', hint = 'stale';
  end if;
  if v_circuit.status = 'published' then
    return v_circuit.edit_no;
  end if;
  if (
    select count(*) from public.passport_circuit_stops s
    join public.content_items i on i.tenant_id = s.tenant_id and i.id = s.content_id
    where s.circuit_id = p_circuit_id and i.published_revision_id is not null
  ) < 2 then
    raise exception 'a published circuit needs two published destinations' using errcode = '23514', hint = 'incomplete';
  end if;
  update public.passport_circuits c
  set status = 'published', published_at = coalesce(c.published_at, now()), edit_no = c.edit_no + 1, updated_at = now()
  where c.id = p_circuit_id;
  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'passport.circuit_published', 'passport_circuit', p_circuit_id,
          v_circuit.edit_no + 1, 'success', '{}'::jsonb);
  return v_circuit.edit_no + 1;
end;
$$;

revoke all on function public.publish_passport_circuit(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.publish_passport_circuit(uuid, uuid, integer) to authenticated;

-- Takes a circuit off the portal (owners and admins); it goes back to being a draft.
create function public.withdraw_passport_circuit(p_tenant_id uuid, p_circuit_id uuid, p_edit_no integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_circuit public.passport_circuits;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  select * into v_circuit from public.passport_circuits c
  where c.tenant_id = p_tenant_id and c.id = p_circuit_id
  for update;
  if v_circuit.id is null then
    raise exception 'circuit not found' using errcode = 'P0002';
  end if;
  if v_circuit.edit_no is distinct from p_edit_no then
    raise exception 'the circuit changed' using errcode = 'PT409', hint = 'stale';
  end if;
  if v_circuit.status = 'draft' then
    return v_circuit.edit_no;
  end if;
  update public.passport_circuits c
  set status = 'draft', edit_no = c.edit_no + 1, updated_at = now()
  where c.id = p_circuit_id;
  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'passport.circuit_withdrawn', 'passport_circuit', p_circuit_id,
          v_circuit.edit_no + 1, 'success', '{}'::jsonb);
  return v_circuit.edit_no + 1;
end;
$$;

revoke all on function public.withdraw_passport_circuit(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.withdraw_passport_circuit(uuid, uuid, integer) to authenticated;

-- Deletes a circuit that was never published (owners and admins). One that visitors saw is
-- withdrawn instead: their stamps and prizes (Pasos 2–3) refer to it.
create function public.delete_passport_circuit(p_tenant_id uuid, p_circuit_id uuid, p_edit_no integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_circuit public.passport_circuits;
begin
  perform private.assert_content_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]);
  select * into v_circuit from public.passport_circuits c
  where c.tenant_id = p_tenant_id and c.id = p_circuit_id
  for update;
  if v_circuit.id is null then
    raise exception 'circuit not found' using errcode = 'P0002';
  end if;
  if v_circuit.edit_no is distinct from p_edit_no then
    raise exception 'the circuit changed' using errcode = 'PT409', hint = 'stale';
  end if;
  if v_circuit.published_at is not null then
    raise exception 'a circuit that was published is withdrawn, not deleted' using errcode = '23514', hint = 'published';
  end if;
  delete from public.passport_circuits c where c.id = p_circuit_id;
  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, revision, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'passport.circuit_deleted', 'passport_circuit', p_circuit_id,
          v_circuit.edit_no, 'success', jsonb_build_object('slug', v_circuit.slug));
end;
$$;

revoke all on function public.delete_passport_circuit(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.delete_passport_circuit(uuid, uuid, integer) to authenticated;

-- ── The portal ─────────────────────────────────────────────────────────────

-- The published circuits of an online municipality, each with the stops whose destination is
-- published now (in the suggested order) and their cover and location. A circuit left with
-- fewer than two such stops is not shown.
create function public.portal_passport(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with stops as (
    select s.circuit_id, s.position, i.slug, r.title, r.summary, r.latitude, r.longitude,
           (select private.public_image(m.asset_version_id, m.alt_text)
            from public.media_references m
            where m.revision_id = r.id and m.purpose = 'cover') as cover
    from public.passport_circuit_stops s
    join public.content_items i on i.tenant_id = s.tenant_id and i.id = s.content_id and i.kind = 'destination'
    join public.content_revisions r on r.id = i.published_revision_id and r.content_id = i.id and r.state = 'sealed'
    where s.tenant_id = p_tenant_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'slug', c.slug,
           'name', c.name,
           'summary', c.summary,
           'reward', c.reward,
           'publishedAt', c.published_at,
           'stops', (
             select jsonb_agg(jsonb_build_object(
                      'slug', st.slug,
                      'title', st.title,
                      'summary', st.summary,
                      'latitude', st.latitude,
                      'longitude', st.longitude,
                      'cover', st.cover
                    ) order by st.position)
             from stops st where st.circuit_id = c.id
           )
         ) order by c.published_at, c.name), '[]'::jsonb)
  from public.passport_circuits c
  join public.tenants t on t.id = c.tenant_id and t.status = 'active'
  where c.tenant_id = p_tenant_id
    and c.status = 'published'
    and (select count(*) from stops st where st.circuit_id = c.id) >= 2;
$$;

revoke all on function public.portal_passport(uuid) from public, anon, authenticated;
grant execute on function public.portal_passport(uuid) to anon, authenticated;
