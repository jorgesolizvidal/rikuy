-- C3 · Paso 1 — modules each municipality has (ADR-060). Expand only.
--
-- 1. A catalog of platform modules (agenda, map, 360° tours, 3D models, tourist passport,
--    visitor assistant, its voice, the Copilot) and the set each municipality has. Destinations
--    and the panel's own pages (brand, members, statistics, usage) are always there.
-- 2. Only the platform operator (second factor) changes a municipality's set; a module that
--    needs another one cannot stay on without it. Turning one off deletes nothing: its content
--    is kept and comes back as it was when the module is turned on again.
-- 3. The set reaches the portal through the host resolution and the panel through the
--    memberships it already reads. New municipalities start with a package chosen at
--    provisioning time («Completo» when none); existing ones keep everything.
-- 4. The database refuses to create content of a module that is off (events, tours,
--    panoramas, 3D models, circuits, knowledge and its documents): the panel hides those
--    pages, and this is the backstop.
--
-- Error codes: 42501 forbidden · 23514 invalid (hint: module | requires) · PT404 tenant ·
-- PT403 module off (hint: the module's key).

-- ── 1. Catalog and per-tenant set ──────────────────────────────────────────

create table public.platform_modules (
  key      text primary key,
  position smallint not null unique,
  requires text references public.platform_modules (key),
  constraint platform_modules_key check (key ~ '^[a-z][a-z_]{1,30}$'),
  constraint platform_modules_requires check (requires is null or requires <> key)
);

comment on table public.platform_modules is
  'Modules a municipality can have (ADR-060). Names and descriptions live in the app.';

insert into public.platform_modules (key, position, requires) values
  ('agenda', 1, null),
  ('map', 2, null),
  ('tours', 3, null),
  ('models', 4, 'tours'),
  ('passport', 5, null),
  ('assistant', 6, null),
  ('voice', 7, 'assistant'),
  ('copilot', 8, null);

create table public.tenant_modules (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  module     text not null references public.platform_modules (key),
  enabled_at timestamptz not null default now(),
  enabled_by uuid references auth.users (id) on delete set null,
  constraint tenant_modules_pkey primary key (tenant_id, module)
);

comment on table public.tenant_modules is
  'Modules a municipality has (ADR-060); only platform functions write it.';

alter table public.platform_modules enable row level security;
alter table public.tenant_modules enable row level security;
revoke all on public.platform_modules from public, anon, authenticated;
revoke all on public.tenant_modules from public, anon, authenticated;

-- Everything a municipality has, in the catalog's order.
create function private.tenant_module_keys(p_tenant_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.module order by p.position), '{}')
  from public.tenant_modules m
  join public.platform_modules p on p.key = m.module
  where m.tenant_id = p_tenant_id;
$$;

create function private.has_module(p_tenant_id uuid, p_module text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tenant_modules m where m.tenant_id = p_tenant_id and m.module = p_module
  );
$$;

create function private.assert_module(p_tenant_id uuid, p_module text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_module(p_tenant_id, p_module) then
    raise exception 'module % is off for this municipality', p_module
      using errcode = 'PT403', hint = p_module;
  end if;
end;
$$;

-- A requested set: known keys, no repeats, every requirement in the set. Raises 23514.
create function private.checked_module_set(p_modules text[])
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_missing text;
begin
  if p_modules is null then
    raise exception 'modules are required' using errcode = '23514', hint = 'module';
  end if;
  if exists (
    select 1 from unnest(p_modules) k
    where k is null or not exists (select 1 from public.platform_modules p where p.key = k)
  ) then
    raise exception 'unknown module' using errcode = '23514', hint = 'module';
  end if;
  if (select count(*) from unnest(p_modules)) <> (select count(distinct k) from unnest(p_modules) k) then
    raise exception 'repeated module' using errcode = '23514', hint = 'module';
  end if;
  select p.key into v_missing
  from public.platform_modules p
  where p.key = any (p_modules) and p.requires is not null and not (p.requires = any (p_modules))
  limit 1;
  if v_missing is not null then
    raise exception 'module % needs another one', v_missing using errcode = '23514', hint = 'requires';
  end if;
  return (
    select coalesce(array_agg(p.key order by p.position), '{}')
    from public.platform_modules p where p.key = any (p_modules)
  );
end;
$$;

-- Replaces a municipality's set; returns the previous one.
create function private.replace_tenant_modules(p_tenant_id uuid, p_modules text[])
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set text[] := private.checked_module_set(p_modules);
  v_previous text[] := private.tenant_module_keys(p_tenant_id);
begin
  delete from public.tenant_modules m
  where m.tenant_id = p_tenant_id and not (m.module = any (v_set));
  insert into public.tenant_modules (tenant_id, module, enabled_by)
  select p_tenant_id, k, (select auth.uid()) from unnest(v_set) k
  on conflict (tenant_id, module) do nothing;
  return v_previous;
end;
$$;

-- Every municipality starts with everything (the «Completo» package); provisioning with
-- another package replaces it in the same transaction.
create function private.tenants_default_modules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tenant_modules (tenant_id, module)
  select new.id, p.key from public.platform_modules p
  on conflict do nothing;
  return null;
end;
$$;

create trigger tenants_default_modules
after insert on public.tenants
for each row execute function private.tenants_default_modules();

-- Existing municipalities keep everything they had.
insert into public.tenant_modules (tenant_id, module)
select t.id, p.key from public.tenants t cross join public.platform_modules p
on conflict do nothing;

-- ── 2. Backstops: no new content for a module that is off ──────────────────

create function private.content_items_module()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'event' then
    perform private.assert_module(new.tenant_id, 'agenda');
  elsif new.kind = 'knowledge' then
    perform private.assert_module(new.tenant_id, 'assistant');
  end if;
  return new;
end;
$$;

create trigger content_items_module
before insert on public.content_items
for each row execute function private.content_items_module();

create function private.tours_module()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_module(new.tenant_id, 'tours');
  return new;
end;
$$;

create trigger tours_module
before insert on public.tours
for each row execute function private.tours_module();

create function private.passport_circuits_module()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_module(new.tenant_id, 'passport');
  return new;
end;
$$;

create trigger passport_circuits_module
before insert on public.passport_circuits
for each row execute function private.passport_circuits_module();

-- A new upload (a new medium or a new version of one) of a panorama, a 3D model or a
-- knowledge document.
create function private.asset_versions_module()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purpose public.asset_purpose;
begin
  select a.purpose into v_purpose
  from public.assets a where a.tenant_id = new.tenant_id and a.id = new.asset_id;
  if v_purpose = 'panorama' then
    perform private.assert_module(new.tenant_id, 'tours');
  elsif v_purpose = 'model' then
    perform private.assert_module(new.tenant_id, 'models');
  elsif v_purpose = 'document' then
    perform private.assert_module(new.tenant_id, 'assistant');
  end if;
  return new;
end;
$$;

create trigger asset_versions_module
before insert on public.asset_versions
for each row execute function private.asset_versions_module();

-- ── 3. The set reaches the portal and the panel ────────────────────────────

-- Same columns plus `modules`: the app that reads it before this migration ignores it.
drop function public.resolve_tenant_by_host(text);

create function public.resolve_tenant_by_host(p_host text)
returns table (
  tenant_id        uuid,
  tenant_slug      text,
  display_name     text,
  default_locale   text,
  timezone         text,
  canonical_host   text,
  is_canonical     boolean,
  active_config_id uuid,
  is_demo          boolean,
  modules          text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id,
    t.slug,
    t.display_name,
    t.default_locale,
    t.timezone,
    c.hostname,
    d.id = t.canonical_domain_id,
    t.active_config_id,
    t.is_demo,
    private.tenant_module_keys(t.id)
  from public.tenant_domains d
  join public.tenants t on t.id = d.tenant_id
  left join public.tenant_domains c
    on c.tenant_id = t.id and c.id = t.canonical_domain_id and c.status = 'active'
  where d.hostname = p_host
    and d.status = 'active'
    and t.status = 'active';
$$;

revoke all on function public.resolve_tenant_by_host(text) from public;
grant execute on function public.resolve_tenant_by_host(text) to anon, authenticated;

drop function public.my_memberships();

create function public.my_memberships()
returns table (
  tenant_id           uuid,
  slug                text,
  display_name        text,
  tenant_status       public.tenant_status,
  is_demo             boolean,
  role                public.membership_role,
  needs_second_factor boolean,
  modules             text[]
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id, t.slug, t.display_name, t.status, t.is_demo, m.role,
    m.role in ('owner', 'admin') and private.current_aal() <> 'aal2',
    private.tenant_module_keys(t.id)
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and t.status in ('provisioning', 'active')
  order by t.display_name;
$$;

revoke all on function public.my_memberships() from public, anon, authenticated;
grant execute on function public.my_memberships() to authenticated;

drop function public.platform_list_tenants();

create function public.platform_list_tenants()
returns table (
  tenant_id      uuid,
  slug           text,
  display_name   text,
  status         public.tenant_status,
  canonical_host text,
  owner_email    text,
  owner_status   public.membership_status,
  created_at     timestamptz,
  is_demo        boolean,
  modules        text[]
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_actor();
  return query
  select
    t.id, t.slug, t.display_name, t.status, d.hostname,
    o.email::text, o.status, t.created_at, t.is_demo, private.tenant_module_keys(t.id)
  from public.tenants t
  left join public.tenant_domains d on d.id = t.canonical_domain_id
  left join lateral (
    select u.email, m.status
    from public.memberships m
    join auth.users u on u.id = m.user_id
    where m.tenant_id = t.id and m.role = 'owner' and m.status in ('active', 'invited')
    order by (m.status = 'active') desc, m.created_at
    limit 1
  ) o on true
  order by t.display_name;
end;
$$;

revoke all on function public.platform_list_tenants() from public, anon, authenticated;
grant execute on function public.platform_list_tenants() to authenticated, service_role;

-- ── 4. The operator chooses them ───────────────────────────────────────────

-- Same function with one more (optional) argument: callers that name their arguments keep
-- working while the app and the database are deployed one after the other. Without
-- modules the municipality starts with everything.
drop function public.provision_tenant(text, text, text, uuid, text, text, boolean);

create function public.provision_tenant(
  p_slug text,
  p_display_name text,
  p_hostname text,
  p_owner_user_id uuid,
  p_default_locale text default 'es',
  p_timezone text default 'America/La_Paz',
  p_demo boolean default false,
  p_modules text[] default null
)
returns table (tenant_id uuid, domain_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_tenant uuid;
  v_domain uuid;
  v_modules text[];
begin
  perform private.assert_platform_actor();

  -- Checked before anything is created.
  if p_modules is not null then
    v_modules := private.checked_module_set(p_modules);
  end if;

  if exists (select 1 from public.tenants t where t.slug = p_slug) then
    raise exception 'slug already in use' using errcode = 'PT409', hint = 'slug';
  end if;
  if exists (select 1 from public.tenant_domains d where d.hostname = p_hostname) then
    raise exception 'hostname already in use' using errcode = 'PT409', hint = 'hostname';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_owner_user_id) then
    raise exception 'owner account not found' using errcode = 'PT404', hint = 'owner';
  end if;

  insert into public.tenants (slug, display_name, status, default_locale, timezone, is_demo)
  values (p_slug, btrim(p_display_name), 'provisioning', p_default_locale, p_timezone, coalesce(p_demo, false))
  returning id into v_tenant;

  if v_modules is not null then
    perform private.replace_tenant_modules(v_tenant, v_modules);
  end if;

  insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at)
  values (v_tenant, p_hostname, 'platform', 'active', now())
  returning id into v_domain;

  update public.tenants t set canonical_domain_id = v_domain where t.id = v_tenant;

  insert into public.memberships (tenant_id, user_id, role, status)
  values (v_tenant, p_owner_user_id, 'owner', 'invited');

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values (
    'tenant', v_tenant, (select auth.uid()), 'tenant.provisioned', 'tenant', v_tenant, 'success',
    jsonb_build_object('slug', p_slug, 'hostname', p_hostname, 'owner_user_id', p_owner_user_id,
                       'demo', coalesce(p_demo, false),
                       'modules', to_jsonb(private.tenant_module_keys(v_tenant)))
  );

  return query select v_tenant, v_domain;
exception
  when unique_violation then
    raise exception 'slug or hostname taken concurrently' using errcode = 'PT409', hint = 'slug';
end;
$$;

revoke all on function public.provision_tenant(text, text, text, uuid, text, text, boolean, text[]) from public, anon, authenticated;
grant execute on function public.provision_tenant(text, text, text, uuid, text, text, boolean, text[]) to authenticated, service_role;

create function public.platform_set_tenant_modules(p_tenant_id uuid, p_modules text[])
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous text[];
  v_current text[];
begin
  perform private.assert_platform_actor();
  -- Locks the municipality: two operators changing it at once apply one after the other.
  perform 1 from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'tenant not found' using errcode = 'PT404', hint = 'tenant';
  end if;

  v_previous := private.replace_tenant_modules(p_tenant_id, p_modules);
  v_current := private.tenant_module_keys(p_tenant_id);

  if v_previous is distinct from v_current then
    insert into public.audit_events (
      scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff
    )
    values (
      'tenant', p_tenant_id, (select auth.uid()), 'platform.modules_changed', 'tenant', p_tenant_id,
      'success', jsonb_build_object('from', to_jsonb(v_previous), 'to', to_jsonb(v_current))
    );
  end if;
  return v_current;
end;
$$;

revoke all on function public.platform_set_tenant_modules(uuid, text[]) from public, anon, authenticated;
grant execute on function public.platform_set_tenant_modules(uuid, text[]) to authenticated;

-- ── 5. The monthly report knows them ───────────────────────────────────────
-- Same as before (C2 · Paso 4), plus «modules»: without the Copilot the report goes without
-- recommendations; without the passport, without its section.
create or replace function worker_api.monthly_report_data(
  p_job_id uuid,
  p_fencing_token bigint,
  p_from date,
  p_to date,
  p_previous_from date,
  p_previous_to date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_month date;
begin
  v_job := private.monthly_report_job(p_job_id, p_fencing_token);
  v_month := (v_job.payload ->> 'month')::date;
  if p_from is distinct from v_month or p_to is null or p_to < p_from
     or p_to >= (v_month + interval '1 month')::date
     or (p_previous_from is null) <> (p_previous_to is null)
     or (p_previous_from is not null and (
       p_previous_to < p_previous_from or p_previous_to >= p_from or p_previous_to - p_previous_from > 31
     )) then
    raise exception 'invalid period' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'current', private.visit_statistics(v_job.tenant_id, p_from, p_to, false),
    'previous', case when p_previous_from is null then null
                     else private.visit_statistics(v_job.tenant_id, p_previous_from, p_previous_to, false) end,
    'questions', private.unanswered_questions_between(v_job.tenant_id, p_from, p_to),
    'review', coalesce((select jsonb_agg(to_jsonb(r)) from private.content_review(v_job.tenant_id) r), '[]'::jsonb),
    'snapshot', private.content_snapshot(v_job.tenant_id),
    'activity', private.content_activity(v_job.tenant_id, p_from, p_to),
    'passport', private.passport_statistics(v_job.tenant_id, p_from, p_to, false),
    'passportPrevious', case when p_previous_from is null then null
                             else private.passport_statistics(v_job.tenant_id, p_previous_from, p_previous_to, false) end,
    'modules', to_jsonb(private.tenant_module_keys(v_job.tenant_id))
  );
end;
$$;

revoke all on function private.tenant_module_keys(uuid) from public;
revoke all on function private.has_module(uuid, text) from public;
revoke all on function private.assert_module(uuid, text) from public;
revoke all on function private.checked_module_set(text[]) from public;
revoke all on function private.replace_tenant_modules(uuid, text[]) from public;
revoke all on function private.tenants_default_modules() from public;
revoke all on function private.content_items_module() from public;
revoke all on function private.tours_module() from public;
revoke all on function private.passport_circuits_module() from public;
revoke all on function private.asset_versions_module() from public;
