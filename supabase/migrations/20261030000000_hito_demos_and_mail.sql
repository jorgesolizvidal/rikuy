-- ★ Hito · Paso 2 — commercial demos and invitation emails (ADR-034). Expand only.
--
-- 1. A municipality can be a commercial demo (tenants.is_demo), chosen by the operator at
--    provisioning time. A demo portal is never indexed and says it is a demo; only a demo
--    offers the sample content of the panel. The flag reaches the portal through the host
--    resolution and the panel through the memberships it already reads.
-- 2. Inviting someone (the owner at provisioning, or a member later) enqueues
--    mail.membership_invitation in the same transaction (outbox). The runner sends the
--    email through SMTP and records it (memberships.invitation_mailed_at). Without SMTP
--    configured the job ends without sending: invitations keep working as before.
--
-- Error codes as in the onboarding migration: 42501 forbidden · 23514 invalid · PT409 · PT404.

-- ── 1. Demo municipalities ──────────────────────────────────────────────────

alter table public.tenants add column is_demo boolean not null default false;

comment on column public.tenants.is_demo is
  'Commercial demo (ADR-034): never indexed, says so on the portal, offers sample content.';

-- Same function with one more (optional) argument: callers that name their arguments keep
-- working while the app and the database are deployed one after the other.
drop function public.provision_tenant(text, text, text, uuid, text, text);

create function public.provision_tenant(
  p_slug text,
  p_display_name text,
  p_hostname text,
  p_owner_user_id uuid,
  p_default_locale text default 'es',
  p_timezone text default 'America/La_Paz',
  p_demo boolean default false
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

  insert into public.tenants (slug, display_name, status, default_locale, timezone, is_demo)
  values (p_slug, btrim(p_display_name), 'provisioning', p_default_locale, p_timezone, coalesce(p_demo, false))
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
    jsonb_build_object('slug', p_slug, 'hostname', p_hostname, 'owner_user_id', p_owner_user_id,
                       'demo', coalesce(p_demo, false))
  );

  return query select v_tenant, v_domain;
exception
  when unique_violation then
    raise exception 'slug or hostname taken concurrently' using errcode = 'PT409', hint = 'slug';
end;
$$;

revoke all on function public.provision_tenant(text, text, text, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.provision_tenant(text, text, text, uuid, text, text, boolean) to authenticated, service_role;

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
  is_demo        boolean
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
    o.email::text, o.status, t.created_at, t.is_demo
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

-- The portal learns it is a demo from the same lookup that finds the tenant.
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
  is_demo          boolean
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
    t.is_demo
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

-- ── 2. Invitation emails ────────────────────────────────────────────────────

alter table public.memberships add column invitation_mailed_at timestamptz;

comment on column public.memberships.invitation_mailed_at is
  'When the email of the current invitation was sent (null: not sent or no SMTP).';

insert into public.job_queues (queue, global_concurrency) values ('mail', 2);

insert into public.job_kinds (kind, queue, max_attempts, lease_seconds, max_active_seconds, tenant_concurrency, description)
values ('mail.membership_invitation', 'mail', 5, 60, 120, 2, 'Correo de invitación');

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
    when p_kind in ('media.expire_abandoned_upload', 'media.process_panorama', 'media.process_model') then
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
    else false
  end;
$$;

-- Every new invitation (a new membership, or a revoked one invited again) enqueues its
-- email. The logical key carries the invitation time: one email per invitation, however
-- many times the row is touched.
create function private.enqueue_invitation_mail()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'invited' and (
    tg_op = 'INSERT' or old.status is distinct from 'invited' or old.invited_at is distinct from new.invited_at
  ) then
    perform private.enqueue_job(
      new.tenant_id, 'mail.membership_invitation',
      'membership:' || new.id::text || ':' || to_char(new.invited_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
      jsonb_build_object('membershipId', new.id), 'membership', new.id
    );
  end if;
  return null;
end;
$$;

revoke all on function private.enqueue_invitation_mail() from public;

create trigger memberships_enqueue_invitation_mail
  after insert or update of status, invited_at on public.memberships
  for each row
  when (new.status = 'invited')
  execute function private.enqueue_invitation_mail();

-- worker_api: what the email of this job's invitation says, read under its lease and
-- checked against the job's own municipality (never the payload's).
--   send          the invitation is pending and its email was not sent yet
--   already_sent  sent before (a retry after the send was recorded)
--   not_pending   accepted, revoked, re-invited later or the municipality is not open
create function worker_api.invitation_mail(p_job_id uuid, p_fencing_token bigint)
returns table (state text, email text, tenant_name text, role public.membership_role, tenant_status public.tenant_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_member public.memberships;
  v_tenant public.tenants;
  v_email text;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'mail.membership_invitation' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;
  if v_job.subject_type is distinct from 'membership' then
    return query select 'not_pending'::text, null::text, null::text, null::public.membership_role, null::public.tenant_status;
    return;
  end if;
  select * into v_member from public.memberships m
  where m.id = v_job.subject_id and m.tenant_id = v_job.tenant_id;
  select * into v_tenant from public.tenants t where t.id = v_job.tenant_id;
  select u.email::text into v_email from auth.users u where u.id = v_member.user_id;

  if v_member.id is null or v_member.status <> 'invited' or v_email is null
     or v_tenant.status not in ('provisioning', 'active')
     -- A later invitation of the same person has its own job.
     or v_job.logical_key <> 'membership:' || v_member.id::text || ':'
                              || to_char(v_member.invited_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS') then
    return query select 'not_pending'::text, null::text, null::text, null::public.membership_role, null::public.tenant_status;
    return;
  end if;
  if v_member.invitation_mailed_at is not null and v_member.invitation_mailed_at >= v_member.invited_at then
    return query select 'already_sent'::text, null::text, null::text, null::public.membership_role, null::public.tenant_status;
    return;
  end if;
  return query select 'send'::text, v_email, v_tenant.display_name, v_member.role, v_tenant.status;
end;
$$;

-- worker_api: the email went out; record it (once) and audit it.
create function worker_api.mark_invitation_mailed(p_job_id uuid, p_fencing_token bigint)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.background_jobs;
  v_id uuid;
begin
  v_job := private.leased_job(p_job_id, p_fencing_token);
  if v_job.kind <> 'mail.membership_invitation' then
    raise exception 'wrong job kind' using errcode = '23514';
  end if;

  update public.memberships m
  set invitation_mailed_at = now()
  where m.id = v_job.subject_id and m.tenant_id = v_job.tenant_id and m.status = 'invited'
    and (m.invitation_mailed_at is null or m.invitation_mailed_at < m.invited_at)
  returning m.id into v_id;
  if v_id is null then
    return 'already_settled';
  end if;

  insert into public.audit_events (
    scope, tenant_id, actor_id, action, entity_type, entity_id, job_id, outcome
  )
  values ('tenant', v_job.tenant_id, null, 'membership.invitation_mailed', 'membership', v_id, v_job.id, 'success');
  return 'marked';
end;
$$;

revoke all on function worker_api.invitation_mail(uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function worker_api.mark_invitation_mailed(uuid, bigint) from public, anon, authenticated, service_role;
grant execute on function worker_api.invitation_mail(uuid, bigint) to rikuy_worker;
grant execute on function worker_api.mark_invitation_mailed(uuid, bigint) to rikuy_worker;

-- Owners and admins see whether the invitation email went out.
drop function public.list_tenant_members(uuid);

create function public.list_tenant_members(p_tenant_id uuid)
returns table (
  membership_id        uuid,
  user_id              uuid,
  email                text,
  role                 public.membership_role,
  status               public.membership_status,
  invited_at           timestamptz,
  accepted_at          timestamptz,
  invitation_mailed_at timestamptz
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
  select m.id, m.user_id, u.email::text, m.role, m.status, m.invited_at, m.accepted_at,
         case when m.invitation_mailed_at >= m.invited_at then m.invitation_mailed_at end
  from public.memberships m
  join auth.users u on u.id = m.user_id
  where m.tenant_id = p_tenant_id
  order by (m.status = 'revoked'), m.role, u.email;
end;
$$;

revoke all on function public.list_tenant_members(uuid) from public, anon, authenticated;
grant execute on function public.list_tenant_members(uuid) to authenticated;
