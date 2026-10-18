-- ─────────────────────────────────────────────────────────────────────────────
-- P1 · Paso 6: platform operator, tenant onboarding, invitations and members.
--
--   * platform_operators is separate from tenant memberships (ADR-004). An operator
--     acts only with a second factor: every operator check requires aal2 in the JWT.
--   * Onboarding is one transaction: tenant (provisioning) + platform domain +
--     canonical pointer + invited owner + audit. The tenant goes live only when the
--     operator activates it, which the database allows only with an ACTIVE owner.
--   * Invitations are memberships in status 'invited'; the invited person accepts
--     them after signing in. Owners/admins manage members through intent RPCs with
--     role rules enforced here (an admin never touches owners or admins).
--   * The only service_role entry point is the user lookup used by the isolated
--     identity-admin adapter (secret key). Nothing here is reachable by anon.
-- Expand-only.
-- ─────────────────────────────────────────────────────────────────────────────

create type public.operator_status as enum ('active', 'revoked');

create table public.platform_operators (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  status     public.operator_status not null default 'active',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint platform_operators_revoked_has_timestamp check ((status = 'revoked') = (revoked_at is not null))
);

alter table public.platform_operators enable row level security;
revoke all on table public.platform_operators from anon, authenticated;
-- Operators are managed out of band (bootstrap script / SQL), never from the app.
grant select, insert, update on table public.platform_operators to service_role;

-- ── Invariant triggers run with owner rights ────────────────────────────────
-- Deferred constraint triggers fire at COMMIT as the calling role, outside the
-- SECURITY DEFINER function that made the change. Under RLS an operator cannot see the
-- domains or memberships of a tenant it is provisioning, so the checks would fail (or,
-- worse, pass vacuously in other shapes). The checks must see every row.
alter function private.validate_tenant_invariants() security definer;
alter function private.ensure_tenant_has_owner() security definer;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Authenticator assurance level of the current JWT ('aal1' when absent).
create function private.current_aal()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', 'aal1');
$$;

create function private.is_service_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'role' = 'service_role', false);
$$;

create function private.is_platform_operator(p_require_mfa boolean default true)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_operators o
    where o.user_id = (select auth.uid()) and o.status = 'active'
  )
  and (not p_require_mfa or private.current_aal() = 'aal2');
$$;

-- Operator with a verified second factor, or the platform's own service role.
create function private.assert_platform_actor()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not (private.is_service_role() or private.is_platform_operator(true)) then
    raise exception 'platform operator with a second factor required' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.current_aal() from public;
revoke all on function private.is_service_role() from public;
revoke all on function private.is_platform_operator(boolean) from public;
revoke all on function private.assert_platform_actor() from public;
-- No grants: these run only inside the SECURITY DEFINER functions below.

-- ── Operator status (drives the /plataforma gate) ──────────────────────────
-- 'none' (not an operator) · 'needs_mfa' (operator, session below aal2) · 'ok'.
create function public.platform_operator_status()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not private.is_platform_operator(false) then 'none'
    when private.current_aal() <> 'aal2' then 'needs_mfa'
    else 'ok'
  end;
$$;

-- ── Tenant onboarding ───────────────────────────────────────────────────────
-- Error codes: 42501 forbidden · 23514 invalid input · PT409 (hint: slug | hostname |
-- owner_pending | status) · PT404 (hint: owner | tenant).

create function public.provision_tenant(
  p_slug text,
  p_display_name text,
  p_hostname text,
  p_owner_user_id uuid,
  p_default_locale text default 'es',
  p_timezone text default 'America/La_Paz'
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
begin
  perform private.assert_platform_actor();

  if exists (select 1 from public.tenants t where t.slug = p_slug) then
    raise exception 'slug already in use' using errcode = 'PT409', hint = 'slug';
  end if;
  if exists (select 1 from public.tenant_domains d where d.hostname = p_hostname) then
    raise exception 'hostname already in use' using errcode = 'PT409', hint = 'hostname';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_owner_user_id) then
    raise exception 'owner account not found' using errcode = 'PT404', hint = 'owner';
  end if;

  insert into public.tenants (slug, display_name, status, default_locale, timezone)
  values (p_slug, btrim(p_display_name), 'provisioning', p_default_locale, p_timezone)
  returning id into v_tenant;

  -- Platform hostnames are under our control (or exact *.vercel.app aliases), so they
  -- are active immediately; custom domains get their own verification flow later.
  insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at)
  values (v_tenant, p_hostname, 'platform', 'active', now())
  returning id into v_domain;

  update public.tenants t set canonical_domain_id = v_domain where t.id = v_tenant;

  insert into public.memberships (tenant_id, user_id, role, status)
  values (v_tenant, p_owner_user_id, 'owner', 'invited');

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values (
    'tenant', v_tenant, (select auth.uid()), 'tenant.provisioned', 'tenant', v_tenant, 'success',
    jsonb_build_object('slug', p_slug, 'hostname', p_hostname, 'owner_user_id', p_owner_user_id)
  );

  return query select v_tenant, v_domain;
exception
  when unique_violation then
    raise exception 'slug or hostname taken concurrently' using errcode = 'PT409', hint = 'slug';
end;
$$;

-- provisioning → active · active → suspended · suspended → active.
create function public.set_tenant_status(p_tenant_id uuid, p_status public.tenant_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current public.tenant_status;
begin
  perform private.assert_platform_actor();

  select t.status into v_current from public.tenants t where t.id = p_tenant_id for update;
  if not found then
    raise exception 'tenant not found' using errcode = 'PT404', hint = 'tenant';
  end if;
  if not (
    (v_current in ('provisioning', 'suspended') and p_status = 'active')
    or (v_current = 'active' and p_status = 'suspended')
  ) then
    raise exception 'transition % → % not allowed', v_current, p_status
      using errcode = 'PT409', hint = 'status';
  end if;
  if p_status = 'active' and not exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id and m.role = 'owner' and m.status = 'active'
  ) then
    raise exception 'the owner has not accepted the invitation yet'
      using errcode = 'PT409', hint = 'owner_pending';
  end if;

  update public.tenants t set status = p_status where t.id = p_tenant_id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values (
    'tenant', p_tenant_id, (select auth.uid()),
    case when p_status = 'active' then 'tenant.activated' else 'tenant.suspended' end,
    'tenant', p_tenant_id, 'success',
    jsonb_build_object('from', v_current, 'to', p_status)
  );
end;
$$;

create function public.platform_list_tenants()
returns table (
  tenant_id      uuid,
  slug           text,
  display_name   text,
  status         public.tenant_status,
  canonical_host text,
  owner_email    text,
  owner_status   public.membership_status,
  created_at     timestamptz
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
    o.email::text, o.status, t.created_at
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

-- ── Invitations ─────────────────────────────────────────────────────────────

-- Invitations addressed to the current user (tenant names are not readable through
-- RLS until the membership is active, hence this function).
create function public.my_pending_invitations()
returns table (tenant_id uuid, slug text, display_name text, role public.membership_role, invited_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.slug, t.display_name, m.role, m.invited_at
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid())
    and m.status = 'invited'
    and t.status in ('provisioning', 'active')
  order by m.invited_at;
$$;

create function public.accept_membership_invitation(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_membership uuid;
begin
  update public.memberships m
  set status = 'active', accepted_at = now()
  where m.tenant_id = p_tenant_id
    and m.user_id = (select auth.uid())
    and m.status = 'invited'
    and exists (
      select 1 from public.tenants t
      where t.id = p_tenant_id and t.status in ('provisioning', 'active')
    )
  returning m.id into v_membership;

  if v_membership is null then
    raise exception 'no pending invitation for this tenant' using errcode = 'PT404', hint = 'invitation';
  end if;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome)
  values ('tenant', p_tenant_id, (select auth.uid()), 'membership.accepted', 'membership', v_membership, 'success');
end;
$$;

-- ── Members (owners and admins) ─────────────────────────────────────────────
-- Owners manage every role. Admins manage only editors and analysts.

create function private.assert_can_manage_member(
  p_tenant_id uuid,
  p_target_role public.membership_role,
  p_new_role public.membership_role
)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if private.has_tenant_role(p_tenant_id, array['owner']::public.membership_role[]) then
    return;
  end if;
  if private.has_tenant_role(p_tenant_id, array['admin']::public.membership_role[])
     and coalesce(p_target_role in ('editor', 'analyst'), true)
     and coalesce(p_new_role in ('editor', 'analyst'), true) then
    return;
  end if;
  raise exception 'not allowed to manage this member' using errcode = '42501';
end;
$$;

revoke all on function private.assert_can_manage_member(uuid, public.membership_role, public.membership_role) from public;

create function public.list_tenant_members(p_tenant_id uuid)
returns table (
  membership_id uuid,
  user_id       uuid,
  email         text,
  role          public.membership_role,
  status        public.membership_status,
  invited_at    timestamptz,
  accepted_at   timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'not allowed to list members' using errcode = '42501';
  end if;
  return query
  select m.id, m.user_id, u.email::text, m.role, m.status, m.invited_at, m.accepted_at
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant_id
  order by (m.status = 'revoked'), m.role, u.email;
end;
$$;

create function public.add_tenant_member(p_tenant_id uuid, p_user_id uuid, p_role public.membership_role)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.memberships%rowtype;
  v_id uuid;
begin
  perform private.assert_can_manage_member(p_tenant_id, null, p_role);
  if not exists (
    select 1 from public.tenants t where t.id = p_tenant_id and t.status in ('provisioning', 'active')
  ) then
    raise exception 'tenant is not accepting members' using errcode = '42501';
  end if;

  select m.* into v_existing
  from public.memberships m
  where m.tenant_id = p_tenant_id and m.user_id = p_user_id
  for update;

  if found and v_existing.status <> 'revoked' then
    raise exception 'already a member' using errcode = 'PT409', hint = 'already_member';
  elsif found then
    -- A revoked member can be invited again; the previous role check applies to it too.
    perform private.assert_can_manage_member(p_tenant_id, v_existing.role, p_role);
    update public.memberships m
    set role = p_role, status = 'invited', invited_at = now(), accepted_at = null, revoked_at = null
    where m.id = v_existing.id
    returning m.id into v_id;
  else
    insert into public.memberships (tenant_id, user_id, role, status)
    values (p_tenant_id, p_user_id, p_role, 'invited')
    returning id into v_id;
  end if;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'membership.invited', 'membership', v_id, 'success',
          jsonb_build_object('role', p_role, 'user_id', p_user_id));
  return v_id;
end;
$$;

create function private.assert_keeps_an_owner(p_tenant_id uuid, p_membership_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.memberships m
    where m.tenant_id = p_tenant_id and m.role = 'owner' and m.status = 'active' and m.id <> p_membership_id
  ) then
    raise exception 'the tenant must keep at least one active owner'
      using errcode = 'PT409', hint = 'last_owner';
  end if;
end;
$$;

revoke all on function private.assert_keeps_an_owner(uuid, uuid) from public;

create function public.change_member_role(p_tenant_id uuid, p_membership_id uuid, p_role public.membership_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.memberships%rowtype;
begin
  select m.* into v_member from public.memberships m
  where m.id = p_membership_id and m.tenant_id = p_tenant_id
  for update;
  if not found or v_member.status = 'revoked' then
    raise exception 'member not found' using errcode = 'PT404', hint = 'member';
  end if;
  perform private.assert_can_manage_member(p_tenant_id, v_member.role, p_role);
  if v_member.role = 'owner' and p_role <> 'owner' and v_member.status = 'active' then
    perform private.assert_keeps_an_owner(p_tenant_id, v_member.id);
  end if;

  update public.memberships m set role = p_role where m.id = v_member.id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'membership.role_changed', 'membership', v_member.id, 'success',
          jsonb_build_object('from', v_member.role, 'to', p_role));
end;
$$;

create function public.revoke_member(p_tenant_id uuid, p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.memberships%rowtype;
begin
  select m.* into v_member from public.memberships m
  where m.id = p_membership_id and m.tenant_id = p_tenant_id
  for update;
  if not found or v_member.status = 'revoked' then
    raise exception 'member not found' using errcode = 'PT404', hint = 'member';
  end if;
  perform private.assert_can_manage_member(p_tenant_id, v_member.role, null);
  if v_member.role = 'owner' and v_member.status = 'active' then
    perform private.assert_keeps_an_owner(p_tenant_id, v_member.id);
  end if;

  update public.memberships m set status = 'revoked', revoked_at = now() where m.id = v_member.id;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  values ('tenant', p_tenant_id, (select auth.uid()), 'membership.revoked', 'membership', v_member.id, 'success',
          jsonb_build_object('role', v_member.role, 'previous_status', v_member.status));
end;
$$;

-- ── Identity lookup for the isolated identity-admin adapter (service_role) ──

create function public.platform_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u where lower(u.email) = lower(btrim(p_email)) limit 1;
$$;

-- ── Privileges ──────────────────────────────────────────────────────────────

revoke all on function public.platform_operator_status() from public, anon, authenticated;
revoke all on function public.provision_tenant(text, text, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.set_tenant_status(uuid, public.tenant_status) from public, anon, authenticated;
revoke all on function public.platform_list_tenants() from public, anon, authenticated;
revoke all on function public.my_pending_invitations() from public, anon, authenticated;
revoke all on function public.accept_membership_invitation(uuid) from public, anon, authenticated;
revoke all on function public.list_tenant_members(uuid) from public, anon, authenticated;
revoke all on function public.add_tenant_member(uuid, uuid, public.membership_role) from public, anon, authenticated;
revoke all on function public.change_member_role(uuid, uuid, public.membership_role) from public, anon, authenticated;
revoke all on function public.revoke_member(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_user_id_by_email(text) from public, anon, authenticated;

grant execute on function public.platform_operator_status() to authenticated;
grant execute on function public.provision_tenant(text, text, text, uuid, text, text) to authenticated, service_role;
grant execute on function public.set_tenant_status(uuid, public.tenant_status) to authenticated, service_role;
grant execute on function public.platform_list_tenants() to authenticated, service_role;
grant execute on function public.my_pending_invitations() to authenticated;
grant execute on function public.accept_membership_invitation(uuid) to authenticated;
grant execute on function public.list_tenant_members(uuid) to authenticated;
grant execute on function public.add_tenant_member(uuid, uuid, public.membership_role) to authenticated;
grant execute on function public.change_member_role(uuid, uuid, public.membership_role) to authenticated;
grant execute on function public.revoke_member(uuid, uuid) to authenticated;
grant execute on function public.platform_user_id_by_email(text) to service_role;
