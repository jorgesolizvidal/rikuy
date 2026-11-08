-- P6 · Paso 1 (ADR-043): owners and admins act on their municipality only with a second
-- factor (aal2); editors and analysts are unchanged; the panel lists what needs it; an
-- operator with a second factor resets a lost factor, audited.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set op1 '00000000-0000-4000-8000-0000000000f1'
\set a1  '00000000-0000-4000-8000-0000000000a1'
\set a2  '00000000-0000-4000-8000-0000000000a2'
\set a3  '00000000-0000-4000-8000-0000000000a3'
\set a4  '00000000-0000-4000-8000-0000000000a4'
\set b1  '00000000-0000-4000-8000-0000000000b1'
\set ta  'aaaaaaaa-0000-4000-8000-000000000001'
\set tb  'bbbbbbbb-0000-4000-8000-000000000001'

\set op_aal1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set a1_aal1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set a1_none '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a1_aal2 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a2_aal1 '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal1"}'
\set a2_aal2 '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set a3_aal1 '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal1"}'
\set a4_aal1 '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal1"}'
\set b1_aal2 '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'

insert into auth.users (id, email) values
  (:'op1', 'operador@example.test'), (:'a1', 'owner.a@example.test'),
  (:'a2', 'admin.a@example.test'), (:'a3', 'editor.a@example.test'),
  (:'a4', 'analyst.a@example.test'), (:'b1', 'owner.b@example.test');
insert into public.platform_operators (user_id) values (:'op1');

insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
-- a3: editor in A and admin in B (works in A without a factor, not in B).
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now()), (:'ta', :'a2', 'admin', 'active', now()),
  (:'ta', :'a3', 'editor', 'active', now()), (:'ta', :'a4', 'analyst', 'active', now()),
  (:'tb', :'b1', 'owner', 'active', now()), (:'tb', :'a3', 'admin', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

-- a1 and a2 have a verified TOTP factor; a3 none; op1 one of its own.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at, secret) values
  ('f0000000-0000-4000-8000-0000000000a1', :'a1', 'Rikuy', 'totp', 'verified', now(), now(), 'AAAA'),
  ('f0000000-0000-4000-8000-0000000000a2', :'a2', 'Rikuy', 'totp', 'verified', now(), now(), 'BBBB'),
  ('f0000000-0000-4000-8000-0000000000f1', :'op1', 'Rikuy', 'totp', 'verified', now(), now(), 'CCCC');

select plan(45);

-- ── Privileges ────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'public.my_memberships()', 'EXECUTE'), 'anon cannot list memberships');
select ok(not has_function_privilege('anon', 'public.tenant_member_second_factors(uuid)', 'EXECUTE'), 'anon cannot read second-factor status');
select ok(not has_function_privilege('anon', 'public.platform_second_factor_reset(text)', 'EXECUTE'), 'anon cannot reset a factor');

set local role authenticated;

-- ── The rule, function by function ────────────────────────────────────────
set local request.jwt.claims to :'a1_aal1';
select ok(not private.has_tenant_role(:'ta', array['owner','admin','editor','analyst']::public.membership_role[]),
  'an owner at aal1 is not a member of their municipality');
set local request.jwt.claims to :'a1_none';
select ok(not private.has_tenant_role(:'ta', array['owner']::public.membership_role[]),
  'a JWT without aal counts as aal1');
set local request.jwt.claims to :'a1_aal2';
select ok(private.has_tenant_role(:'ta', array['owner']::public.membership_role[]),
  'the same owner at aal2 is');
set local request.jwt.claims to :'a2_aal1';
select ok(not private.has_tenant_role(:'ta', array['owner','admin','editor','analyst']::public.membership_role[]),
  'an admin at aal1 is not a member either');
set local request.jwt.claims to :'a3_aal1';
select ok(private.has_tenant_role(:'ta', array['editor']::public.membership_role[]),
  'an editor needs no second factor');
select ok(not private.has_tenant_role(:'tb', array['owner','admin','editor','analyst']::public.membership_role[]),
  'the same person, admin in another municipality, needs it there');
set local request.jwt.claims to :'a4_aal1';
select ok(private.has_tenant_role(:'ta', array['analyst']::public.membership_role[]),
  'an analyst needs no second factor');

-- ── Tables, RPCs and Storage, without the factor ──────────────────────────
set local request.jwt.claims to :'a1_aal1';
select is((select count(*)::int from public.tenants where id = :'ta'), 0, 'owner at aal1: the tenant row is not readable');
select is((select count(*)::int from public.memberships where tenant_id = :'ta' and user_id <> :'a1'), 0,
  'owner at aal1: the roster is not readable');
select is((select count(*)::int from public.memberships where user_id = :'a1'), 1,
  'owner at aal1: their own membership stays readable');
select throws_ok(format('select * from public.list_tenant_members(%L)', :'ta'), '42501', null,
  'owner at aal1 cannot list members');
select throws_ok(format('select public.add_tenant_member(%L, %L, ''editor'')', :'ta', :'b1'), '42501', null,
  'owner at aal1 cannot invite');
select throws_ok(format('select * from public.create_content_item(%L, ''destination'', ''mirador'', ''Mirador'')', :'ta'),
  '42501', null, 'owner at aal1 cannot create content');
select throws_ok(format('select * from public.create_image_upload(%L, ''logo'', ''image/png'', 1000)', :'ta'),
  '42501', null, 'owner at aal1 cannot start an upload');
select throws_ok(format('select * from public.tenant_usage(%L)', :'ta'), '42501', null,
  'owner at aal1 cannot read the usage');

-- With the factor, the same person creates a draft and starts an upload…
set local request.jwt.claims to :'a1_aal2';
create temp table fx on commit drop as
  select c.content_id, c.edit_count from public.create_content_item(:'ta', 'destination', 'mirador', 'Mirador') c;
create temp table up on commit drop as
  select u.original_path from public.create_image_upload(:'ta', 'logo', 'image/png', 1000) u;
grant select on fx, up to authenticated;
select is((select count(*)::int from fx), 1, 'owner at aal2 creates content');
select ok(private.can_upload_original((select original_path from up)), 'owner at aal2 may write the original');

-- …that the same session without the factor cannot publish, edit or upload.
set local request.jwt.claims to :'a1_aal1';
select throws_ok(
  format('select * from public.publish_content(%L, %L, %s)', :'ta', (select content_id from fx), (select edit_count from fx)),
  '42501', null, 'owner at aal1 cannot publish');
select ok(not private.can_upload_original((select original_path from up)),
  'owner at aal1 may not write the original (Storage policy)');
select is((select count(*)::int from public.content_items where tenant_id = :'ta'), 0,
  'owner at aal1 reads no content');

set local request.jwt.claims to :'a2_aal1';
select throws_ok(format('select * from public.list_tenant_members(%L)', :'ta'), '42501', null,
  'admin at aal1 cannot list members');
set local request.jwt.claims to :'a2_aal2';
select is((select count(*)::int from public.list_tenant_members(:'ta')), 4, 'admin at aal2 lists the members');

-- The editor keeps working without a factor.
set local request.jwt.claims to :'a3_aal1';
select is((select count(*)::int from public.content_items where tenant_id = :'ta'), 1,
  'the editor reads the content without a second factor');

-- ── my_memberships ────────────────────────────────────────────────────────
set local request.jwt.claims to :'a1_aal1';
select results_eq('select slug, role::text, needs_second_factor from public.my_memberships()',
  $$values ('tenant-a', 'owner', true)$$, 'owner at aal1: listed, needing the factor');
set local request.jwt.claims to :'a1_aal2';
select results_eq('select slug, needs_second_factor from public.my_memberships()',
  $$values ('tenant-a', false)$$, 'owner at aal2: listed, nothing needed');
set local request.jwt.claims to :'a3_aal1';
select results_eq('select slug, role::text, needs_second_factor from public.my_memberships()',
  $$values ('tenant-a', 'editor', false), ('tenant-b', 'admin', true)$$,
  'editor in A and admin in B: only B needs it');
select results_eq(
  'select distinct is_demo, tenant_status::text from public.my_memberships()',
  $$values (false, 'active')$$, 'tenant status and demo flag come along');
set local request.jwt.claims to :'op_aal2';
select is((select count(*)::int from public.my_memberships()), 0, 'an operator without memberships lists nothing');

-- ── Who set up a second factor (owners and admins only) ───────────────────
set local request.jwt.claims to :'a1_aal2';
select results_eq(
  format('select m.user_id, s.configured from public.tenant_member_second_factors(%L) s
          join public.memberships m on m.id = s.membership_id order by m.user_id', :'ta'),
  format('values (%L::uuid, true), (%L::uuid, true)', :'a1', :'a2'),
  'owners and admins of A, both configured; no editors or analysts');
set local request.jwt.claims to :'a3_aal1';
select throws_ok(format('select * from public.tenant_member_second_factors(%L)', :'ta'), '42501', null,
  'an editor cannot read it');
set local request.jwt.claims to :'b1_aal2';
select throws_ok(format('select * from public.tenant_member_second_factors(%L)', :'ta'), '42501', null,
  'another municipality cannot read it');

-- ── The operator resets a lost factor ─────────────────────────────────────
set local request.jwt.claims to :'op_aal1';
select throws_ok('select public.platform_second_factor_reset(''owner.a@example.test'')', '42501', null,
  'an operator without a second factor cannot reset');
set local request.jwt.claims to :'a2_aal2';
select throws_ok('select public.platform_second_factor_reset(''owner.a@example.test'')', '42501', null,
  'an admin is not an operator');
set local request.jwt.claims to :'op_aal2';
select throws_ok('select public.platform_second_factor_reset(''analyst.a@example.test'')', 'PT404', null,
  'an analyst is not reset (no factor is required of them)');
select throws_ok('select public.platform_second_factor_reset(''nadie@example.test'')', 'PT404', null,
  'unknown email');
select throws_ok('select public.platform_second_factor_reset(''operador@example.test'')', 'PT404', null,
  'the operator is not staff of any municipality');
select is(public.platform_second_factor_reset('  OWNER.A@example.test '), 1, 'resets by email, case and spaces ignored');
reset role;
select is((select count(*)::int from auth.mfa_factors where user_id = :'a1'), 0, 'the owner has no factor left');
select is((select count(*)::int from auth.mfa_factors where user_id in (:'a2', :'op1')), 2, 'nobody else lost theirs');
select results_eq(
  format('select tenant_id, actor_id, (diff ->> ''factors_removed'')::int from public.audit_events
          where action = ''membership.second_factor_reset'' and diff ->> ''user_id'' = %L', :'a1'),
  format('values (%L::uuid, %L::uuid, 1)', :'ta', :'op1'),
  'audited in the owner''s municipality, by the operator');
set local role authenticated;
set local request.jwt.claims to :'a1_aal2';
select results_eq(
  format('select configured from public.tenant_member_second_factors(%L) s join public.memberships m on m.id = s.membership_id where m.user_id = %L', :'ta', :'a1'),
  $$values (false)$$, 'the panel shows the owner without a factor now');

-- An operator who is also an owner cannot reset themselves here.
reset role;
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values (:'tb', :'op1', 'admin', 'active', now());
set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select throws_ok('select public.platform_second_factor_reset(''operador@example.test'')', 'PT409', null,
  'an operator who is staff somewhere cannot reset their own factor');

select * from finish();
rollback;
