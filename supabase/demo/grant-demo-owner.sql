-- Cloud demo: makes one person OWNER of the two demo municipalities. Run in the SQL editor of
-- the cloud project after that person exists (e.g. `pnpm platform:add-operator <correo>`).
-- Replace the email on the first line; no personal email is kept in the repository.
-- After this, every other change goes through «Miembros» in the panel.

begin;

create temporary table demo_owner on commit drop as
select id as user_id from auth.users where email = lower('CORREO@EJEMPLO.COM');

insert into public.memberships (tenant_id, user_id, role, status, accepted_at)
select t.id, o.user_id, 'owner', 'active', now()
from public.tenants t
cross join demo_owner o
where t.slug in ('demo-norte', 'demo-sur')
on conflict (tenant_id, user_id) do update
set role = 'owner', status = 'active', accepted_at = now(), revoked_at = null;

insert into public.audit_events (scope, tenant_id, actor_id, action, entity_type, outcome, diff)
select 'tenant', t.id, null, 'membership.granted_by_operator', 'membership', 'success',
       jsonb_build_object('role', 'owner', 'via', 'sql_editor')
from public.tenants t
where t.slug in ('demo-norte', 'demo-sur')
  and exists (select 1 from demo_owner);

-- Two rows (owner, active) expected; none means the email has no account yet.
select t.slug, m.role, m.status
from public.memberships m
join public.tenants t on t.id = m.tenant_id
join demo_owner o on o.user_id = m.user_id;

commit;
