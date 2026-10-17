-- ─────────────────────────────────────────────────────────────────────────────
-- P1 · Foundation: tenants, domain registry, memberships, versioned config, audit.
--
-- Security model (docs/architecture.md §4–§6, ADR-003/004/015/016):
--   * Every tenant-owned row carries tenant_id; cross-entity references use
--     composite FKs (tenant_id, id) so a row can never point into another tenant.
--   * RLS is enabled on every table. anon gets NO table access; tenant resolution
--     for public portals goes through public.resolve_tenant_by_host().
--   * authenticated gets read-only, column-limited access governed by the
--     caller's CURRENT membership. All writes arrive later through intent RPCs.
--   * SECURITY DEFINER helpers live in the non-exposed `private` schema, use an
--     empty search_path and fully qualified names, and return booleans only.
-- ─────────────────────────────────────────────────────────────────────────────

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- ── Enumerations ────────────────────────────────────────────────────────────

create type public.tenant_status as enum ('provisioning', 'active', 'suspended');
create type public.membership_role as enum ('owner', 'admin', 'editor', 'analyst');
create type public.membership_status as enum ('invited', 'active', 'revoked');
create type public.domain_kind as enum ('platform', 'custom');
create type public.domain_status as enum (
  'requested', 'ownership_verified', 'dns_pending', 'tls_pending',
  'active', 'failed', 'suspended', 'removing'
);
create type public.config_state as enum ('draft', 'sealed');
create type public.audit_scope as enum ('tenant', 'platform');
create type public.audit_outcome as enum ('success', 'denied', 'error');

-- ── Generic triggers ────────────────────────────────────────────────────────

create function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function private.forbid_tenant_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id is immutable on %', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ── tenants ─────────────────────────────────────────────────────────────────

create table public.tenants (
  id                  uuid primary key default gen_random_uuid(),
  slug                text not null unique,
  display_name        text not null,
  status              public.tenant_status not null default 'provisioning',
  default_locale      text not null,
  timezone            text not null,
  canonical_domain_id uuid,
  active_config_id    uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint tenants_slug_format check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
  constraint tenants_slug_not_reserved check (
    slug not in ('app', 'api', 'www', 'admin', 'assets', 'cdn', 'status', 'staging', 'preview', 'mail', 'auth')
  ),
  constraint tenants_display_name_length check (char_length(btrim(display_name)) between 1 and 120),
  constraint tenants_locale_format check (default_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  constraint tenants_timezone_present check (char_length(timezone) between 1 and 64)
);

create index tenants_status_idx on public.tenants (status);

create trigger tenants_touch_updated_at
  before update on public.tenants
  for each row execute function private.touch_updated_at();

-- ── tenant_domains (registry used to resolve a portal from its host) ───────

create table public.tenant_domains (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants (id) on delete restrict,
  hostname                text not null unique,
  kind                    public.domain_kind not null,
  status                  public.domain_status not null default 'requested',
  generation              integer not null default 1,
  verification_token_hash text,
  challenge_expires_at    timestamptz,
  provider_domain_id      text,
  verified_at             timestamptz,
  last_error              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint tenant_domains_tenant_id_id_key unique (tenant_id, id),
  -- lowercase ASCII (IDNA already applied), no port, no trailing dot, labels ≤ 63.
  constraint tenant_domains_hostname_format check (
    char_length(hostname) <= 253
    and hostname ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$'
  ),
  constraint tenant_domains_generation_positive check (generation >= 1),
  constraint tenant_domains_active_is_verified check (status <> 'active' or verified_at is not null),
  constraint tenant_domains_last_error_length check (last_error is null or char_length(last_error) <= 500)
);

create index tenant_domains_tenant_status_idx on public.tenant_domains (tenant_id, status);
create index tenant_domains_revalidation_idx on public.tenant_domains (status, updated_at)
  where status in ('requested', 'ownership_verified', 'dns_pending', 'tls_pending');

create trigger tenant_domains_touch_updated_at
  before update on public.tenant_domains
  for each row execute function private.touch_updated_at();
create trigger tenant_domains_forbid_tenant_change
  before update of tenant_id on public.tenant_domains
  for each row execute function private.forbid_tenant_change();

-- ── memberships ─────────────────────────────────────────────────────────────

create table public.memberships (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.membership_role not null,
  status      public.membership_status not null default 'invited',
  invited_at  timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint memberships_tenant_id_id_key unique (tenant_id, id),
  constraint memberships_tenant_user_key unique (tenant_id, user_id),
  constraint memberships_active_has_acceptance check (status <> 'active' or accepted_at is not null),
  constraint memberships_revoked_has_timestamp check (status <> 'revoked' or revoked_at is not null)
);

create index memberships_user_status_idx on public.memberships (user_id, status);
create index memberships_tenant_role_idx on public.memberships (tenant_id, role) where status = 'active';

create trigger memberships_touch_updated_at
  before update on public.memberships
  for each row execute function private.touch_updated_at();
create trigger memberships_forbid_tenant_change
  before update of tenant_id on public.memberships
  for each row execute function private.forbid_tenant_change();

-- An active tenant must always keep at least one active owner. Deferred, so an
-- ownership transfer can demote and promote inside one transaction.
create function private.ensure_tenant_has_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_tenant uuid := old.tenant_id;
begin
  if exists (select 1 from public.tenants t where t.id = v_tenant and t.status = 'active')
     and not exists (
       select 1 from public.memberships m
       where m.tenant_id = v_tenant and m.role = 'owner' and m.status = 'active'
     ) then
    raise exception 'tenant % must keep at least one active owner', v_tenant
      using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger memberships_keep_one_owner
  after update or delete on public.memberships
  deferrable initially deferred
  for each row execute function private.ensure_tenant_has_owner();

-- ── tenant_config_versions (white-label configuration, versioned) ──────────

create table public.tenant_config_versions (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete restrict,
  version        integer not null,
  schema_version integer not null default 1,
  branding       jsonb not null default '{}'::jsonb,
  settings       jsonb not null default '{}'::jsonb,
  state          public.config_state not null default 'draft',
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  sealed_at      timestamptz,

  constraint tenant_config_versions_tenant_id_id_key unique (tenant_id, id),
  constraint tenant_config_versions_tenant_version_key unique (tenant_id, version),
  constraint tenant_config_versions_version_positive check (version >= 1),
  constraint tenant_config_versions_branding_object check (jsonb_typeof(branding) = 'object'),
  constraint tenant_config_versions_settings_object check (jsonb_typeof(settings) = 'object'),
  constraint tenant_config_versions_sealed_has_timestamp check ((state = 'sealed') = (sealed_at is not null))
);

-- Sealed versions are immutable and cannot be deleted.
create function private.protect_sealed_config()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.state = 'sealed' then
    raise exception 'sealed configuration versions are immutable'
      using errcode = 'check_violation';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger tenant_config_versions_protect_sealed
  before update or delete on public.tenant_config_versions
  for each row execute function private.protect_sealed_config();
create trigger tenant_config_versions_forbid_tenant_change
  before update of tenant_id on public.tenant_config_versions
  for each row execute function private.forbid_tenant_change();

-- ── tenants → own canonical domain / own sealed config (composite FKs) ─────
-- Note: if a canonical domain is later suspended, resolution simply stops
-- returning it as canonical (see resolve_tenant_by_host); no stale redirect.

alter table public.tenants
  add constraint tenants_canonical_domain_fkey
    foreign key (id, canonical_domain_id)
    references public.tenant_domains (tenant_id, id)
    deferrable initially deferred,
  add constraint tenants_active_config_fkey
    foreign key (id, active_config_id)
    references public.tenant_config_versions (tenant_id, id)
    deferrable initially deferred;

-- Checked at commit time (deferred) so provisioning can create the tenant, its
-- domain, config and first owner in a single transaction.
create function private.validate_tenant_invariants()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'active' and not exists (
    select 1 from public.memberships m
    where m.tenant_id = new.id and m.role = 'owner' and m.status = 'active'
  ) then
    raise exception 'an active tenant needs at least one active owner'
      using errcode = 'check_violation';
  end if;

  if new.canonical_domain_id is not null and not exists (
    select 1 from public.tenant_domains d
    where d.id = new.canonical_domain_id and d.tenant_id = new.id and d.status = 'active'
  ) then
    raise exception 'canonical domain must be an active domain of the same tenant'
      using errcode = 'check_violation';
  end if;

  if new.active_config_id is not null and not exists (
    select 1 from public.tenant_config_versions c
    where c.id = new.active_config_id and c.tenant_id = new.id and c.state = 'sealed'
  ) then
    raise exception 'active configuration must be a sealed version of the same tenant'
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger tenants_validate_invariants
  after insert or update of status, canonical_domain_id, active_config_id on public.tenants
  deferrable initially deferred
  for each row execute function private.validate_tenant_invariants();

-- ── audit_events (append-only) ──────────────────────────────────────────────

create table public.audit_events (
  id          uuid primary key default gen_random_uuid(),
  scope       public.audit_scope not null,
  tenant_id   uuid references public.tenants (id) on delete restrict,
  actor_id    uuid, -- kept even if the auth user is later deleted
  action      text not null,
  entity_type text,
  entity_id   uuid,
  revision    integer,
  request_id  text,
  job_id      uuid,
  outcome     public.audit_outcome not null,
  diff        jsonb,
  occurred_at timestamptz not null default now(),

  constraint audit_events_scope_tenant check ((scope = 'tenant') = (tenant_id is not null)),
  constraint audit_events_action_format check (action ~ '^[a-z][a-z0-9_.]{2,79}$'),
  constraint audit_events_diff_object check (diff is null or jsonb_typeof(diff) = 'object')
);

create index audit_events_tenant_time_idx on public.audit_events (tenant_id, occurred_at desc);
create index audit_events_entity_time_idx
  on public.audit_events (tenant_id, entity_type, entity_id, occurred_at desc);
create index audit_events_request_idx on public.audit_events (request_id) where request_id is not null;

create function private.forbid_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events is append-only' using errcode = 'check_violation';
end;
$$;

create trigger audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function private.forbid_audit_mutation();

-- ── Authorization helper (definer, boolean only) ────────────────────────────

-- True when the current JWT subject has an ACTIVE membership in p_tenant with one
-- of the given roles. Reads memberships as the function owner, which avoids RLS
-- recursion on the memberships policies. Revocation takes effect immediately even
-- if the caller's JWT is still valid, because membership state is read live.
create function private.has_tenant_role(p_tenant uuid, p_roles public.membership_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.tenant_id = p_tenant
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.role = any (p_roles)
  );
$$;

revoke all on function private.has_tenant_role(uuid, public.membership_role[]) from public;
grant execute on function private.has_tenant_role(uuid, public.membership_role[]) to authenticated;

-- ── Public tenant resolution (portal host → minimal tenant DTO) ────────────

-- Exact match on a normalized host (lowercase, no port, no trailing dot — the app
-- normalizes before calling). Only active domains of active tenants resolve.
-- Unknown or suspended hosts return zero rows; there is no default tenant.
create function public.resolve_tenant_by_host(p_host text)
returns table (
  tenant_id        uuid,
  tenant_slug      text,
  display_name     text,
  default_locale   text,
  timezone         text,
  canonical_host   text,
  is_canonical     boolean,
  active_config_id uuid
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
    t.active_config_id
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

-- ── Privileges: deny by default, then grant the minimum ─────────────────────

revoke all on table
  public.tenants,
  public.tenant_domains,
  public.memberships,
  public.tenant_config_versions,
  public.audit_events
from anon, authenticated;

grant select on table public.tenants to authenticated;
grant select on table public.memberships to authenticated;
grant select on table public.tenant_config_versions to authenticated;
grant select on table public.audit_events to authenticated;
-- Domain registry: never expose verification token hashes or provider internals.
grant select (id, tenant_id, hostname, kind, status, generation, verified_at, created_at, updated_at)
  on table public.tenant_domains to authenticated;

-- ── Row Level Security ──────────────────────────────────────────────────────

alter table public.tenants enable row level security;
alter table public.tenant_domains enable row level security;
alter table public.memberships enable row level security;
alter table public.tenant_config_versions enable row level security;
alter table public.audit_events enable row level security;

create policy tenants_select_members
  on public.tenants for select to authenticated
  using (private.has_tenant_role(id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));

create policy tenant_domains_select_managers
  on public.tenant_domains for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));

-- Each user sees their own memberships; owners/admins see the whole tenant roster.
create policy memberships_select_self
  on public.memberships for select to authenticated
  using (user_id = (select auth.uid()));
create policy memberships_select_managers
  on public.memberships for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));

create policy tenant_config_versions_select_members
  on public.tenant_config_versions for select to authenticated
  using (private.has_tenant_role(tenant_id, array['owner', 'admin', 'editor', 'analyst']::public.membership_role[]));

create policy audit_events_select_managers
  on public.audit_events for select to authenticated
  using (scope = 'tenant' and private.has_tenant_role(tenant_id, array['owner', 'admin']::public.membership_role[]));
