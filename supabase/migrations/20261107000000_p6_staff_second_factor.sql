-- P6 · Paso 1 — second factor required for the owners and administrators of a municipality
-- (ADR-043, concretes ADR-004). Expand only.
--
-- - private.has_tenant_role counts an ACTIVE owner or admin membership only when the JWT
--   carries aal2. Every tenant authorization goes through it (RPCs, table RLS, Storage), so
--   without the second factor an owner or admin is simply not a member of that
--   municipality. Editors and analysts are unchanged.
-- - my_memberships(): the caller's active memberships with needs_second_factor, read from
--   the same JWT, so the panel can list a municipality it cannot open yet and send the
--   person to /verificacion.
-- - tenant_member_second_factors(): for owners and admins (with their own second factor),
--   which owners and admins of the municipality already set one up.
-- - platform_second_factor_reset(): an operator with a second factor removes the TOTP
--   factors of an owner or admin who lost their phone, and audits it in each of their
--   municipalities, in one transaction.

-- ── The rule ──────────────────────────────────────────────────────────────

create or replace function private.has_tenant_role(p_tenant uuid, p_roles public.membership_role[])
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
      -- ADR-043: owners and admins act only with a verified second factor in this session.
      and (m.role not in ('owner', 'admin') or private.current_aal() = 'aal2')
  );
$$;

-- ── What the panel lists ──────────────────────────────────────────────────

create function public.my_memberships()
returns table (
  tenant_id           uuid,
  slug                text,
  display_name        text,
  tenant_status       public.tenant_status,
  is_demo             boolean,
  role                public.membership_role,
  needs_second_factor boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    t.id, t.slug, t.display_name, t.status, t.is_demo, m.role,
    m.role in ('owner', 'admin') and private.current_aal() <> 'aal2'
  from public.memberships m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and t.status in ('provisioning', 'active')
  order by t.display_name;
$$;

-- Owners and admins see which owners and admins of their municipality have a verified
-- TOTP factor (the «Miembros» page). Nothing else of auth.mfa_factors is exposed.
create function public.tenant_member_second_factors(p_tenant_id uuid)
returns table (membership_id uuid, configured boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.has_tenant_role(p_tenant_id, array['owner', 'admin']::public.membership_role[]) then
    raise exception 'not allowed to read the members' using errcode = '42501';
  end if;
  return query
  select
    m.id,
    exists (
      select 1 from auth.mfa_factors f
      where f.user_id = m.user_id and f.factor_type::text = 'totp' and f.status::text = 'verified'
    )
  from public.memberships m
  where m.tenant_id = p_tenant_id
    and m.role in ('owner', 'admin')
    and m.status in ('active', 'invited');
end;
$$;

-- ── The operator resets a lost factor ─────────────────────────────────────
-- Error codes: 42501 not an operator with a second factor · PT404 (hint: person) no owner
-- or admin with that email · PT409 (hint: self) the operator's own account.

create function public.platform_second_factor_reset(p_email text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid;
  v_removed integer;
begin
  if not private.is_platform_operator(true) then
    raise exception 'platform operator with a second factor required' using errcode = '42501';
  end if;

  select u.id into v_user
  from auth.users u
  where lower(u.email) = lower(btrim(coalesce(p_email, '')))
  limit 1;

  if v_user is null or not exists (
    select 1 from public.memberships m
    where m.user_id = v_user and m.role in ('owner', 'admin') and m.status in ('active', 'invited')
  ) then
    raise exception 'no owner or admin with that email' using errcode = 'PT404', hint = 'person';
  end if;

  if v_user = (select auth.uid()) then
    raise exception 'an operator does not reset their own factor here'
      using errcode = 'PT409', hint = 'self';
  end if;

  delete from auth.mfa_factors f where f.user_id = v_user and f.factor_type::text = 'totp';
  get diagnostics v_removed = row_count;

  insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, entity_id, outcome, diff)
  select 'tenant', m.tenant_id, (select auth.uid()), 'membership.second_factor_reset', 'membership', m.id,
         'success', jsonb_build_object('user_id', v_user, 'factors_removed', v_removed)
  from public.memberships m
  where m.user_id = v_user and m.role in ('owner', 'admin') and m.status in ('active', 'invited');

  return v_removed;
end;
$$;

-- ── Privileges ────────────────────────────────────────────────────────────

revoke all on function public.my_memberships() from public, anon, authenticated;
revoke all on function public.tenant_member_second_factors(uuid) from public, anon, authenticated;
revoke all on function public.platform_second_factor_reset(text) from public, anon, authenticated;

grant execute on function public.my_memberships() to authenticated;
grant execute on function public.tenant_member_second_factors(uuid) to authenticated;
grant execute on function public.platform_second_factor_reset(text) to authenticated;
