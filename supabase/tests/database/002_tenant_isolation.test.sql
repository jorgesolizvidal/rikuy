-- Tenant isolation by membership: who can read what, including revocation and
-- users that belong to two tenants. Fixtures are synthetic and rolled back.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a5', 'revoked.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test'),
  ('00000000-0000-4000-8000-0000000000ab', 'both.ab@example.test'),
  ('00000000-0000-4000-8000-0000000000ff', 'outsider@example.test');

insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'tenant-a', 'Tenant A', 'active', 'es', 'America/La_Paz'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'tenant-b', 'Tenant B', 'active', 'es', 'America/La_Paz');

insert into public.memberships (tenant_id, user_id, role, status, accepted_at, revoked_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'owner',   'active',  now(), null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', 'admin',   'active',  now(), null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a3', 'editor',  'active',  now(), null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active',  now(), null),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a5', 'admin',   'revoked', now(), now()),
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000ab', 'editor',  'active',  now(), null),
  ('bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1', 'owner',   'active',  now(), null),
  ('bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000ab', 'analyst', 'active',  now(), null);

insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at, verification_token_hash) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a.example.test', 'platform', 'active', now(), 'hash-a'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'b.example.test', 'platform', 'active', now(), 'hash-b');

insert into public.tenant_config_versions (tenant_id, version, state, sealed_at) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 1, 'sealed', now()),
  ('bbbbbbbb-0000-4000-8000-000000000001', 1, 'sealed', now());

insert into public.audit_events (scope, tenant_id, action, outcome) values
  ('tenant', 'aaaaaaaa-0000-4000-8000-000000000001', 'tenant.created', 'success'),
  ('tenant', 'bbbbbbbb-0000-4000-8000-000000000001', 'tenant.created', 'success'),
  ('platform', null, 'platform.bootstrap', 'success');

select plan(25);

-- ── anon: no direct table access ────────────────────────────────────────────
set local role anon;
select throws_ok('select * from public.tenants', '42501', null, 'anon cannot read tenants');
select throws_ok('select * from public.memberships', '42501', null, 'anon cannot read memberships');
select throws_ok('select id from public.tenant_domains', '42501', null, 'anon cannot read domains');
reset role;

-- ── owner of A ──────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}';
set local role authenticated;
select results_eq('select slug from public.tenants', array['tenant-a'], 'owner A sees only tenant A');
select is((select count(*)::int from public.memberships), 6, 'owner A sees the full roster of A (6) and nothing of B');
select results_eq('select hostname from public.tenant_domains', array['a.example.test'], 'owner A sees only A domains');
select is((select count(*)::int from public.tenant_config_versions), 1, 'owner A sees only A config');
select is((select count(*)::int from public.audit_events), 1, 'owner A sees only A tenant audit, no platform events');
select throws_ok(
  'select verification_token_hash from public.tenant_domains', '42501', null,
  'owner A cannot read domain verification hashes'
);
select is(
  (select count(*)::int from public.tenants where id = 'bbbbbbbb-0000-4000-8000-000000000001'),
  0, 'owner A cannot fetch tenant B by id'
);
select throws_ok(
  $$update public.tenants set display_name = 'x' where id = 'aaaaaaaa-0000-4000-8000-000000000001'$$,
  '42501', null, 'owner A cannot update tenants directly (RPC only)'
);
select throws_ok(
  $$insert into public.memberships (tenant_id, user_id, role) values ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000ff', 'owner')$$,
  '42501', null, 'owner A cannot insert memberships directly (RPC only)'
);
reset role;

-- ── admin of A ──────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.memberships), 6, 'admin A sees the roster of A');
select is((select count(*)::int from public.tenant_domains), 1, 'admin A sees A domains');
reset role;

-- ── editor of A ─────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}';
set local role authenticated;
select results_eq('select slug from public.tenants', array['tenant-a'], 'editor A sees tenant A');
select is((select count(*)::int from public.memberships), 1, 'editor A sees only their own membership');
select is((select count(*)::int from public.tenant_domains), 0, 'editor A cannot see the domain registry');
select is((select count(*)::int from public.audit_events), 0, 'editor A cannot read audit events');
reset role;

-- ── analyst of A ────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.memberships), 1, 'analyst A cannot list other members (no emails/roster)');
select is((select count(*)::int from public.tenant_config_versions), 1, 'analyst A can read A config');
reset role;

-- ── revoked admin of A: revocation is immediate even with a valid JWT ──────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000a5","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.tenants), 0, 'revoked member sees no tenant');
select is((select count(*)::int from public.tenant_domains), 0, 'revoked admin sees no domains');
reset role;

-- ── member of A (editor) and B (analyst) ────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000ab","role":"authenticated"}';
set local role authenticated;
select results_eq('select slug from public.tenants order by slug', array['tenant-a', 'tenant-b'], 'member of A and B sees both tenants');
select is((select count(*)::int from public.memberships), 2, 'member of A and B sees only their two memberships, not either roster');
reset role;

-- ── outsider ────────────────────────────────────────────────────────────────
set local request.jwt.claims to '{"sub":"00000000-0000-4000-8000-0000000000ff","role":"authenticated"}';
set local role authenticated;
select is((select count(*)::int from public.tenants), 0, 'authenticated user without membership sees nothing');
reset role;

select * from finish();
rollback;
