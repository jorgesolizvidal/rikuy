-- Platform operator (MFA), tenant onboarding, invitations and member management.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set op1  '00000000-0000-4000-8000-0000000000f1'
\set op2  '00000000-0000-4000-8000-0000000000f2'
\set a1   '00000000-0000-4000-8000-0000000000a1'
\set a2   '00000000-0000-4000-8000-0000000000a2'
\set a3   '00000000-0000-4000-8000-0000000000a3'
\set a4   '00000000-0000-4000-8000-0000000000a4'
\set n1   '00000000-0000-4000-8000-0000000000c1'
\set b1   '00000000-0000-4000-8000-0000000000b1'
\set ta   'aaaaaaaa-0000-4000-8000-000000000001'
\set tb   'bbbbbbbb-0000-4000-8000-000000000001'

\set op_aal1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op2_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f2","role":"authenticated","aal":"aal2"}'
\set a1_aal2 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a2c '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated"}'
\set n1c '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set svc '{"role":"service_role"}'

insert into auth.users (id, email) values
  (:'op1', 'operador@example.test'), (:'op2', 'ex-operador@example.test'),
  (:'a1', 'owner.a@example.test'), (:'a2', 'admin.a@example.test'),
  (:'a3', 'editor.a@example.test'), (:'a4', 'analyst.a@example.test'),
  (:'n1', 'nuevo@example.test'), (:'b1', 'owner.b@example.test');

insert into public.platform_operators (user_id, status, revoked_at) values
  (:'op1', 'active', null), (:'op2', 'revoked', now());

insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', :'a1', 'owner', 'active', now()), (:'ta', :'a2', 'admin', 'active', now()),
  (:'ta', :'a3', 'editor', 'active', now()), (:'ta', :'a4', 'analyst', 'active', now()),
  (:'tb', :'b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

select plan(54);

-- ── Privileges ──────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'public.provision_tenant(text, text, text, uuid, text, text)', 'EXECUTE'), 'anon cannot provision');
select ok(not has_function_privilege('anon', 'public.platform_user_id_by_email(text)', 'EXECUTE'), 'anon cannot look up users');
select ok(not has_function_privilege('authenticated', 'public.platform_user_id_by_email(text)', 'EXECUTE'), 'users cannot look up other users');
select ok(has_function_privilege('service_role', 'public.platform_user_id_by_email(text)', 'EXECUTE'), 'the identity adapter (service role) can look up users');
set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select throws_ok('select * from public.platform_operators', '42501', null, 'nobody reads the operator table directly');

-- ── Operator status requires a second factor ───────────────────────────────
set local request.jwt.claims to :'op_aal1';
select is(public.platform_operator_status(), 'needs_mfa', 'an operator without MFA in this session must verify');
set local request.jwt.claims to :'op_aal2';
select is(public.platform_operator_status(), 'ok', 'an operator with aal2 is in');
set local request.jwt.claims to :'a1_aal2';
select is(public.platform_operator_status(), 'none', 'a tenant owner is not an operator');
set local request.jwt.claims to :'op2_aal2';
select is(public.platform_operator_status(), 'none', 'a revoked operator is not an operator');

-- ── Provisioning ────────────────────────────────────────────────────────────
set local request.jwt.claims to :'op_aal1';
select throws_ok(
  format('select * from public.provision_tenant(%L, %L, %L, %L)', 'tenant-c', 'Tenant C', 'c.example.test', :'n1'),
  '42501', null, 'an operator without MFA cannot provision'
);
set local request.jwt.claims to :'a1_aal2';
select throws_ok(
  format('select * from public.provision_tenant(%L, %L, %L, %L)', 'tenant-c', 'Tenant C', 'c.example.test', :'n1'),
  '42501', null, 'a tenant owner cannot provision'
);
set local request.jwt.claims to :'op_aal2';
-- Deferred invariants must hold when they fire as the operator (as at COMMIT in the API).
set constraints all deferred;
select lives_ok(
  format('select * from public.provision_tenant(%L, %L, %L, %L)', 'tenant-c', '  Tenant C ', 'c.example.test', :'n1'),
  'the operator provisions tenant C with an invited owner'
);
select lives_ok('set constraints all immediate', 'tenant invariants hold at commit time under the operator role');
select throws_ok(
  format('select * from public.provision_tenant(%L, %L, %L, %L)', 'tenant-c', 'Otro', 'otro.example.test', :'n1'),
  'PT409', null, 'slugs are unique'
);
select throws_ok(
  format('select * from public.provision_tenant(%L, %L, %L, %L)', 'tenant-x', 'Otro', 'c.example.test', :'n1'),
  'PT409', null, 'hostnames are unique'
);
select throws_ok(
  format('select * from public.provision_tenant(%L, %L, %L, %L)', 'tenant-x', 'Otro', 'x.example.test', '00000000-0000-4000-8000-00000000dead'),
  'PT404', null, 'the owner account must exist'
);
select throws_ok(
  format('select * from public.provision_tenant(%L, %L, %L, %L)', 'app', 'Reservado', 'app.example.test', :'n1'),
  '23514', null, 'reserved slugs are rejected'
);
reset role;

select results_eq(
  $$select t.status::text, t.display_name, d.hostname from public.tenants t join public.tenant_domains d on d.id = t.canonical_domain_id where t.slug = 'tenant-c'$$,
  $$values ('provisioning'::text, 'Tenant C'::text, 'c.example.test'::text)$$,
  'tenant C is provisioning with its canonical platform domain'
);
select results_eq(
  format($$select m.role::text, m.status::text from public.memberships m join public.tenants t on t.id = m.tenant_id where t.slug = 'tenant-c' and m.user_id = %L$$, :'n1'),
  $$values ('owner'::text, 'invited'::text)$$,
  'the owner is invited, not yet active'
);
select is(
  (select actor_id from public.audit_events where action = 'tenant.provisioned'),
  :'op1'::uuid, 'provisioning is audited with the operator as actor'
);
set local role anon;
select is((select count(*)::int from public.resolve_tenant_by_host('c.example.test')), 0, 'a provisioning tenant has no public portal');
reset role;

-- ── Activation needs an accepted owner ──────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'op_aal2';
select throws_ok(
  $$select public.set_tenant_status((select tenant_id from public.platform_list_tenants() where slug = 'tenant-c'), 'active')$$,
  'PT409', null, 'a tenant cannot go live before its owner accepts'
);

-- ── Invitations ─────────────────────────────────────────────────────────────
set local request.jwt.claims to :'n1c';
select results_eq(
  $$select slug, role::text from public.my_pending_invitations()$$,
  $$values ('tenant-c'::text, 'owner'::text)$$,
  'the invited person sees the invitation'
);
select is((select count(*)::int from public.tenants), 0, 'but cannot read the tenant before accepting');
set local request.jwt.claims to :'b1c';
select throws_ok(
  $$select public.accept_membership_invitation((select tenant_id from public.my_pending_invitations() limit 1))$$,
  'PT404', null, 'someone else cannot accept it'
);
set local request.jwt.claims to :'n1c';
select lives_ok(
  $$select public.accept_membership_invitation((select tenant_id from public.my_pending_invitations() limit 1))$$,
  'the invited owner accepts'
);
select is((select count(*)::int from public.tenants where slug = 'tenant-c'), 1, 'the owner now reads the tenant');
select is((select count(*)::int from public.my_pending_invitations()), 0, 'no pending invitation remains');

-- ── Lifecycle ───────────────────────────────────────────────────────────────
set local request.jwt.claims to :'op_aal1';
select throws_ok(
  $$select public.set_tenant_status('aaaaaaaa-0000-4000-8000-000000000001', 'suspended')$$,
  '42501', null, 'status changes need MFA'
);
set local request.jwt.claims to :'op_aal2';
set constraints all deferred;
select lives_ok(
  $$select public.set_tenant_status((select tenant_id from public.platform_list_tenants() where slug = 'tenant-c'), 'active')$$,
  'the operator activates tenant C'
);
select lives_ok('set constraints all immediate', 'activation invariants hold at commit time under the operator role');
set local role anon;
select is((select tenant_slug from public.resolve_tenant_by_host('c.example.test')), 'tenant-c', 'tenant C is live on its host');
set local role authenticated;
select throws_ok(
  $$select public.set_tenant_status((select tenant_id from public.platform_list_tenants() where slug = 'tenant-c'), 'active')$$,
  'PT409', null, 'activating an active tenant is rejected'
);
select lives_ok(
  $$select public.set_tenant_status((select tenant_id from public.platform_list_tenants() where slug = 'tenant-c'), 'suspended')$$,
  'the operator suspends tenant C'
);
set local role anon;
select is((select count(*)::int from public.resolve_tenant_by_host('c.example.test')), 0, 'a suspended tenant has no public portal');
set local role authenticated;
select results_eq(
  $$select slug, owner_email, owner_status::text from public.platform_list_tenants() where slug like 'tenant-%' order by slug$$,
  $$values ('tenant-a'::text, 'owner.a@example.test'::text, 'active'::text),
           ('tenant-b', 'owner.b@example.test', 'active'),
           ('tenant-c', 'nuevo@example.test', 'active')$$,
  'the operator lists every tenant with its owner'
);
set local request.jwt.claims to :'a1_aal2';
select throws_ok('select * from public.platform_list_tenants()', '42501', null, 'a tenant owner cannot list all tenants');

-- The platform service role can provision too (automation and scripts).
set local role service_role;
set local request.jwt.claims to :'svc';
select lives_ok(
  format('select * from public.provision_tenant(%L, %L, %L, %L)', 'tenant-d', 'Tenant D', 'd.example.test', :'n1'),
  'the service role can provision'
);
reset role;

-- ── Members of tenant A ─────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is((select count(*)::int from public.list_tenant_members(:'ta')), 4, 'the owner lists the members with their emails');
set local request.jwt.claims to :'a3c';
select throws_ok(format('select * from public.list_tenant_members(%L)', :'ta'), '42501', null, 'an editor cannot list members');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.list_tenant_members(%L)', :'ta'), '42501', null, 'the owner of B cannot list members of A');

set local request.jwt.claims to :'a2c';
select lives_ok(format('select public.add_tenant_member(%L, %L, %L)', :'ta', :'n1', 'editor'), 'an admin invites an editor');
select throws_ok(format('select public.add_tenant_member(%L, %L, %L)', :'ta', :'b1', 'admin'), '42501', null, 'an admin cannot invite another admin');
select throws_ok(format('select public.add_tenant_member(%L, %L, %L)', :'ta', :'a3', 'analyst'), 'PT409', null, 'an existing member cannot be invited twice');
select lives_ok(
  format($$select public.change_member_role(%L, (select id from public.memberships where tenant_id = %L and user_id = %L), 'analyst')$$, :'ta', :'ta', :'a3'),
  'an admin turns an editor into an analyst'
);
select throws_ok(
  format($$select public.change_member_role(%L, (select id from public.memberships where tenant_id = %L and user_id = %L), 'editor')$$, :'ta', :'ta', :'a1'),
  '42501', null, 'an admin cannot demote the owner'
);

set local request.jwt.claims to :'a1c';
select lives_ok(
  format($$select public.change_member_role(%L, (select id from public.memberships where tenant_id = %L and user_id = %L), 'editor')$$, :'ta', :'ta', :'a2'),
  'the owner demotes the admin'
);
select throws_ok(
  format($$select public.revoke_member(%L, (select id from public.memberships where tenant_id = %L and user_id = %L))$$, :'ta', :'ta', :'a1'),
  'PT409', null, 'the last owner cannot be revoked'
);
select throws_ok(
  format($$select public.change_member_role(%L, (select id from public.memberships where tenant_id = %L and user_id = %L), 'admin')$$, :'ta', :'ta', :'a1'),
  'PT409', null, 'the last owner cannot demote themselves'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format($$select public.revoke_member(%L, (select id from public.memberships where tenant_id = %L and user_id = %L))$$, :'ta', :'ta', :'a4'),
  'PT404', null, 'the owner of B cannot even address members of A'
);
set local request.jwt.claims to :'a1c';
select lives_ok(
  format($$select public.revoke_member(%L, (select id from public.memberships where tenant_id = %L and user_id = %L))$$, :'ta', :'ta', :'a4'),
  'the owner revokes the analyst'
);
set local request.jwt.claims to :'a4c';
select is((select count(*)::int from public.tenants), 0, 'the revoked analyst loses access at once');
set local request.jwt.claims to :'a1c';
select lives_ok(format('select public.add_tenant_member(%L, %L, %L)', :'ta', :'a4', 'analyst'), 'a revoked member can be invited again');
reset role;

select is(
  (select count(*)::int from public.audit_events where action like 'membership.%' and tenant_id = :'ta'),
  5, 'every membership change of A is audited'
);

select * from finish();
rollback;
