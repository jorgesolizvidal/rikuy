-- Public tenant resolution: exact host match, active only, no default tenant.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000c1', 'owner.c@example.test');

insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'tenant-a', 'Tenant A', 'active', 'es', 'America/La_Paz'),
  ('cccccccc-0000-4000-8000-000000000001', 'tenant-c', 'Tenant C', 'active', 'es', 'America/La_Paz');

insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  ('cccccccc-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 'owner', 'active', now());

insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at) values
  ('dddddddd-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'a.example.test', 'platform', 'active', now()),
  ('dddddddd-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'alias.a.example.test', 'custom', 'active', now()),
  ('dddddddd-0000-4000-8000-0000000000a3', 'aaaaaaaa-0000-4000-8000-000000000001', 'pending.a.example.test', 'custom', 'dns_pending', null),
  ('dddddddd-0000-4000-8000-00000000000c', 'cccccccc-0000-4000-8000-000000000001', 'c.example.test', 'platform', 'active', now());

update public.tenants set canonical_domain_id = 'dddddddd-0000-4000-8000-00000000000a'
where id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- Tenant C is suspended after setup
update public.tenants set status = 'suspended' where id = 'cccccccc-0000-4000-8000-000000000001';

set constraints all immediate;

select plan(8);

set local role anon;

select results_eq(
  $$select tenant_slug, canonical_host, is_canonical from public.resolve_tenant_by_host('a.example.test')$$,
  $$values ('tenant-a'::text, 'a.example.test'::text, true)$$,
  'canonical host resolves to its tenant'
);
select results_eq(
  $$select tenant_slug, canonical_host, is_canonical from public.resolve_tenant_by_host('alias.a.example.test')$$,
  $$values ('tenant-a'::text, 'a.example.test'::text, false)$$,
  'alias resolves and reports the canonical host (for a 308 redirect)'
);
select is_empty($$select * from public.resolve_tenant_by_host('unknown.example.test')$$, 'unknown host resolves to nothing (no default tenant)');
select is_empty($$select * from public.resolve_tenant_by_host('pending.a.example.test')$$, 'domain not yet active does not resolve');
select is_empty($$select * from public.resolve_tenant_by_host('c.example.test')$$, 'suspended tenant does not resolve');
select is_empty($$select * from public.resolve_tenant_by_host('A.EXAMPLE.TEST')$$, 'matching is exact; the app normalizes hosts first');
select is_empty($$select * from public.resolve_tenant_by_host('a.example.test:3000')$$, 'ports are never part of a registered host');
select throws_ok('select * from public.tenant_domains', '42501', null, 'anon still cannot read the registry itself');

reset role;

select * from finish();
rollback;
