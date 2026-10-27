-- ★ Hito · Paso 2 (ADR-034): commercial demos and invitation emails.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set op1 '00000000-0000-4000-8000-0000000000f1'
\set a1  '00000000-0000-4000-8000-0000000000a1'
\set a2  '00000000-0000-4000-8000-0000000000a2'
\set n1  '00000000-0000-4000-8000-0000000000c1'
\set b1  '00000000-0000-4000-8000-0000000000b1'
\set tb  'bbbbbbbb-0000-4000-8000-000000000001'
\set op_aal2 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a2c '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'

insert into auth.users (id, email) values
  (:'op1', 'operador@example.test'), (:'a1', 'owner.demo@example.test'),
  (:'a2', 'owner.real@example.test'), (:'n1', 'nuevo@example.test'), (:'b1', 'owner.b@example.test');
insert into public.platform_operators (user_id, status) values (:'op1', 'active');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'tb', :'b1', 'owner', 'active', now());
update public.tenants set status = 'active' where id = :'tb';
set constraints all immediate;

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated, rikuy_worker;
grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

select plan(31);

-- ── Demo municipalities ─────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'op_aal2';
insert into ids select 'demo', tenant_id from public.provision_tenant(
  'demo-valle', 'Demo Valle', 'demo-valle.localhost', :'a1', p_demo => true);
insert into ids select 'real', tenant_id from public.provision_tenant(
  'pueblo-real', 'Pueblo Real', 'pueblo-real.localhost', :'a2');
select is((select is_demo from public.platform_list_tenants() where slug = 'demo-valle'), true,
  'the operator provisions a commercial demo');
select is((select is_demo from public.platform_list_tenants() where slug = 'pueblo-real'), false,
  'a municipality is not a demo unless the operator says so');
reset role;
select is((select diff ->> 'demo' from public.audit_events where action = 'tenant.provisioned'
           and tenant_id = (select id from ids where name = 'demo')), 'true', 'and the audit says it is a demo');

-- Visitors only reach active municipalities; the demo flag comes with the lookup.
set local role anon;
select is((select count(*)::int from public.resolve_tenant_by_host('demo-valle.localhost')), 0,
  'a demo in preparation is not online either');
reset role;
update public.memberships set status = 'active', accepted_at = now() where tenant_id in (select id from ids);
update public.tenants set status = 'active' where id in (select id from ids);
set local role anon;
select is((select is_demo from public.resolve_tenant_by_host('demo-valle.localhost')), true,
  'the portal of a demo knows it is one');
select is((select is_demo from public.resolve_tenant_by_host('pueblo-real.localhost')), false,
  'the portal of a real municipality is not');
reset role;

-- Members read the flag of their own municipality only (the panel shows the sample content).
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is((select is_demo from public.tenants where slug = 'demo-valle'), true, 'its owner sees it is a demo');
select is((select count(*)::int from public.tenants where slug = 'pueblo-real'), 0,
  'and nothing of another municipality');
-- Only the platform marks a demo: members cannot change it.
select throws_ok($$update public.tenants set is_demo = false where slug = 'demo-valle'$$,
  '42501', null, 'not even its owner can turn the demo into a real municipality');
reset role;

-- ── Invitation emails: enqueued with the invitation ─────────────────────────
select is((select count(*)::int from public.background_jobs where kind = 'mail.membership_invitation'
           and tenant_id in (select id from ids)), 2, 'provisioning queued the email of each owner');
select is((select payload from public.background_jobs where kind = 'mail.membership_invitation'
           and tenant_id = (select id from ids where name = 'demo')),
          jsonb_build_object('membershipId', (select id from public.memberships
            where tenant_id = (select id from ids where name = 'demo') and user_id = :'a1')),
  'the job carries the membership only, never the address');

set local role authenticated;
set local request.jwt.claims to :'a1c';
insert into ids values ('inv', public.add_tenant_member((select id from ids where name = 'demo'), :'n1', 'editor'));
reset role;
select is((select count(*)::int from public.background_jobs where kind = 'mail.membership_invitation'
           and subject_id = (select id from ids where name = 'inv')), 1, 'inviting a member queues its email');
update public.memberships set role = 'analyst' where id = (select id from ids where name = 'inv');
select is((select count(*)::int from public.background_jobs where kind = 'mail.membership_invitation'
           and subject_id = (select id from ids where name = 'inv')), 1, 'changing the pending invitation sends nothing new');

select throws_ok(
  format($$select private.enqueue_job(%L, 'mail.membership_invitation', 'x', '{"membershipId":"x","email":"a@b.c"}'::jsonb)$$,
    (select id from ids where name = 'demo')),
  '23514', null, 'a payload with anything else (an address) is refused');

-- ── The runner sends it ─────────────────────────────────────────────────────
-- Leave only the editor's email in the queue.
update public.background_jobs set status = 'succeeded', finished_at = now()
where kind = 'mail.membership_invitation' and subject_id <> (select id from ids where name = 'inv');
set local role rikuy_worker;
create temp table c1 as select * from worker_api.claim_jobs('runner-a', 5, array['mail.membership_invitation']);
select is((select count(*)::int from c1), 1, 'the runner claims the email');
select results_eq(
  format('select state, email, tenant_name, role::text, tenant_status::text from worker_api.invitation_mail(%L, %s)',
    (select job_id from c1), (select fencing_token from c1)),
  $$values ('send', 'nuevo@example.test', 'Demo Valle', 'analyst', 'active')$$,
  'it reads the address, the municipality and the role under its lease');
select throws_ok(
  format('select * from worker_api.invitation_mail(%L, %s)', (select job_id from c1), (select fencing_token from c1) + 9),
  'PT409', null, 'without the current token it reads nothing');
select is(worker_api.mark_invitation_mailed((select job_id from c1), (select fencing_token from c1)), 'marked',
  'the sent email is recorded');
select is(worker_api.mark_invitation_mailed((select job_id from c1), (select fencing_token from c1)), 'already_settled',
  'once');
select is((select state from worker_api.invitation_mail((select job_id from c1), (select fencing_token from c1))),
  'already_sent', 'a retry after recording does not send it again');
select throws_ok($$select * from public.memberships$$, '42501', null, 'the runner still reads no table');
select worker_api.complete_job((select job_id from c1), (select fencing_token from c1), '{"outcome":"sent"}', '{}');
reset role;
select is((select count(*)::int from public.audit_events where action = 'membership.invitation_mailed'
           and entity_id = (select id from ids where name = 'inv')), 1, 'and audited');
-- (now() is fixed inside this test's transaction: move the first invitation an hour back,
-- without triggers.)
set local session_replication_role = replica;
update public.memberships set invited_at = invited_at - interval '1 hour',
       invitation_mailed_at = invitation_mailed_at - interval '1 hour'
where id = (select id from ids where name = 'inv');
update public.background_jobs set logical_key = logical_key || '-earlier'
where kind = 'mail.membership_invitation' and subject_id = (select id from ids where name = 'inv');
set local session_replication_role = origin;

set local role authenticated;
set local request.jwt.claims to :'a1c';
select isnt((select invitation_mailed_at from public.list_tenant_members((select id from ids where name = 'demo'))
             where membership_id = (select id from ids where name = 'inv')), null,
  'the owner sees that the email went out');
-- Revoke and invite again: a new invitation, a new email.
select lives_ok(format('select public.revoke_member(%L, %L)', (select id from ids where name = 'demo'),
  (select id from ids where name = 'inv')), 'the owner revokes the invitation');
select lives_ok(format('select public.add_tenant_member(%L, %L, %L)', (select id from ids where name = 'demo'),
  :'n1', 'editor'), 'and invites the person again');
select is((select invitation_mailed_at from public.list_tenant_members((select id from ids where name = 'demo'))
           where membership_id = (select id from ids where name = 'inv')), null,
  'the new invitation shows no email yet');
reset role;
select is((select count(*)::int from public.background_jobs where kind = 'mail.membership_invitation'
           and subject_id = (select id from ids where name = 'inv')), 2, 'the new invitation has its own email');

set local role rikuy_worker;
create temp table c2 as select * from worker_api.claim_jobs('runner-b', 5, array['mail.membership_invitation']);
select is((select state from worker_api.invitation_mail((select job_id from c2), (select fencing_token from c2))),
  'send', 'the runner sends the new invitation');
reset role;
-- Accepting before the email goes out leaves nothing to send.
update public.memberships set status = 'active', accepted_at = now() where id = (select id from ids where name = 'inv');
set local role rikuy_worker;
select is((select state from worker_api.invitation_mail((select job_id from c2), (select fencing_token from c2))),
  'not_pending', 'an accepted invitation is not emailed');
reset role;

-- Nobody else reads or marks invitation emails.
set local role authenticated;
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from worker_api.invitation_mail(%L, 1)', gen_random_uuid()),
  '42501', null, 'a member of another municipality cannot use the runner functions');
select throws_ok($$select count(*) from public.background_jobs$$, '42501', null, 'nor read the jobs');
reset role;

select * from finish();
rollback;
