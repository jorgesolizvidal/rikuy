-- Data invariants enforced by the database itself (not only by the app).
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'owner2.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');

insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'tenant-a', 'Tenant A', 'active', 'es', 'America/La_Paz'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'tenant-b', 'Tenant B', 'active', 'es', 'America/La_Paz');

insert into public.memberships (id, tenant_id, user_id, role, status, accepted_at) values
  ('11111111-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  ('11111111-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', 'admin', 'active', now()),
  ('22222222-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());

insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at) values
  ('dddddddd-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'a.example.test', 'platform', 'active', now()),
  ('dddddddd-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'pending.a.example.test', 'custom', 'dns_pending', null),
  ('dddddddd-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000001', 'b.example.test', 'platform', 'active', now());

insert into public.tenant_config_versions (id, tenant_id, version, state, sealed_at) values
  ('cccccccc-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 1, 'sealed', now()),
  ('cccccccc-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 2, 'draft', null),
  ('cccccccc-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000001', 1, 'sealed', now());

set constraints all immediate;

select plan(20);

-- tenant_id is immutable
select throws_ok(
  $$update public.memberships set tenant_id = 'bbbbbbbb-0000-4000-8000-000000000001' where id = '11111111-0000-4000-8000-000000000002'$$,
  '23514', null, 'membership cannot move to another tenant'
);
select throws_ok(
  $$update public.tenant_domains set tenant_id = 'bbbbbbbb-0000-4000-8000-000000000001' where id = 'dddddddd-0000-4000-8000-00000000000a'$$,
  '23514', null, 'domain cannot move to another tenant'
);

-- Composite FKs: a tenant can only point at its own domain/config
select throws_ok(
  $$update public.tenants set canonical_domain_id = 'dddddddd-0000-4000-8000-00000000000b' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '23503', null, 'tenant A cannot use a domain of tenant B as canonical'
);
select throws_ok(
  $$update public.tenants set active_config_id = 'cccccccc-0000-4000-8000-00000000000b' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '23503', null, 'tenant A cannot activate a config of tenant B'
);

-- Pointers must reference an ACTIVE domain / SEALED config
select throws_ok(
  $$update public.tenants set canonical_domain_id = 'dddddddd-0000-4000-8000-0000000000a2' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '23514', null, 'canonical domain must be active'
);
select throws_ok(
  $$update public.tenants set active_config_id = 'cccccccc-0000-4000-8000-0000000000a2' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '23514', null, 'active config must be sealed'
);
select lives_ok(
  $$update public.tenants set canonical_domain_id = 'dddddddd-0000-4000-8000-00000000000a', active_config_id = 'cccccccc-0000-4000-8000-00000000000a' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  'own active domain and sealed config are accepted'
);

-- Sealed configuration is immutable; drafts are editable
select throws_ok(
  $$update public.tenant_config_versions set settings = '{"x":1}' where id = 'cccccccc-0000-4000-8000-00000000000a'$$,
  '23514', null, 'sealed config cannot be edited'
);
select throws_ok(
  $$delete from public.tenant_config_versions where id = 'cccccccc-0000-4000-8000-00000000000a'$$,
  '23514', null, 'sealed config cannot be deleted'
);
select lives_ok(
  $$update public.tenant_config_versions set settings = '{"name":"A"}' where id = 'cccccccc-0000-4000-8000-0000000000a2'$$,
  'draft config can be edited'
);

-- Last active owner of an active tenant cannot be removed
select throws_ok(
  $$update public.memberships set status = 'revoked', revoked_at = now() where id = '11111111-0000-4000-8000-000000000001'$$,
  '23514', null, 'cannot revoke the last active owner'
);
select throws_ok(
  $$update public.memberships set role = 'admin' where id = '11111111-0000-4000-8000-000000000001'$$,
  '23514', null, 'cannot demote the last active owner'
);
select throws_ok(
  $$delete from public.memberships where id = '11111111-0000-4000-8000-000000000001'$$,
  '23514', null, 'cannot delete the last active owner'
);
select lives_ok(
  $$update public.memberships set role = 'owner' where id = '11111111-0000-4000-8000-000000000002';
    update public.memberships set role = 'admin' where id = '11111111-0000-4000-8000-000000000001'$$,
  'ownership can be transferred when another active owner exists'
);

-- An active tenant needs an owner
select throws_ok(
  $$insert into public.tenants (slug, display_name, status, default_locale, timezone) values ('orphan', 'Orphan', 'active', 'es', 'UTC')$$,
  '23514', null, 'a tenant cannot be created active without an owner'
);
select lives_ok(
  $$insert into public.tenants (slug, display_name, status, default_locale, timezone) values ('provisioning-x', 'Provisioning X', 'provisioning', 'es', 'UTC')$$,
  'a tenant can be provisioned before it has an owner'
);

-- Reserved/invalid identifiers
select throws_ok(
  $$insert into public.tenants (slug, display_name, default_locale, timezone) values ('app', 'Reserved', 'es', 'UTC')$$,
  '23514', null, 'reserved slugs are rejected'
);
select throws_ok(
  $$insert into public.tenant_domains (tenant_id, hostname, kind) values ('aaaaaaaa-0000-4000-8000-000000000001', 'Upper.Example.Test', 'custom')$$,
  '23514', null, 'hostnames must be normalized lowercase'
);

-- Audit is append-only
insert into public.audit_events (id, scope, tenant_id, action, outcome)
values ('eeeeeeee-0000-4000-8000-000000000001', 'tenant', 'aaaaaaaa-0000-4000-8000-000000000001', 'tenant.updated', 'success');
select throws_ok(
  $$update public.audit_events set outcome = 'error' where id = 'eeeeeeee-0000-4000-8000-000000000001'$$,
  '23514', null, 'audit events cannot be modified'
);
select throws_ok(
  $$delete from public.audit_events where id = 'eeeeeeee-0000-4000-8000-000000000001'$$,
  '23514', null, 'audit events cannot be deleted'
);

select * from finish();
rollback;
