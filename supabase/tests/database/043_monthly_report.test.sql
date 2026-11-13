-- The monthly report (C1 · Paso 5, ADR-055): the panel's reads moved into private functions
-- answer as before; any member reads a month's report; owners and admins ask for it again,
-- up to 3 times a day; the daily task enqueues the month that ended once; the job reads and
-- writes only its own municipality under its lease; its recommendations pass the same checks
-- as the panel's and rest on a platform Copilot request; the email is recorded once per job;
-- the recommendations are forgotten after 90 days. Nobody reads the table directly.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set ownera1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set admina '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set analysta '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set req 'cccccccc-0000-4000-8000-000000000001'
\set req_person 'cccccccc-0000-4000-8000-000000000002'
\set req_b 'cccccccc-0000-4000-8000-000000000003'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'admin.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'admin', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;
grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

-- The municipality's month today, and the next one's first day (when the task runs).
select date_trunc('month', (now() at time zone 'America/La_Paz'))::date as month,
       (now() at time zone 'America/La_Paz')::date as today,
       (date_trunc('month', (now() at time zone 'America/La_Paz')) + interval '1 month')::date as next_month \gset

insert into public.ai_requests (id, tenant_id, profile, status, outcome, actor_id, created_at, finished_at) values
  (:'req', :'ta', 'copilot', 'completed', 'answered', null, now(), now()),
  (:'req_person', :'ta', 'copilot', 'completed', 'answered', '00000000-0000-4000-8000-0000000000a1', now(), now()),
  (:'req_b', :'tb', 'copilot', 'completed', 'answered', null, now(), now());

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated, rikuy_worker;

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
reset role;
-- The museum published today for the first time; the plaza published before, and again today.
insert into public.content_revisions (tenant_id, content_id, revision_no, state, title, sealed_at)
values
  (:'ta', (select id from ids where name = 'museo'), 2, 'sealed', 'Museo', now()),
  (:'ta', (select id from ids where name = 'plaza'), 2, 'sealed', 'Plaza', now() - interval '60 days'),
  (:'ta', (select id from ids where name = 'plaza'), 3, 'sealed', 'Plaza', now());

create temp table expected as select
  private.visit_statistics(:'ta', :'month', :'today', false) as stats,
  private.unanswered_questions_between(:'ta', (:'today'::date - 29), :'today') as q30,
  private.unanswered_questions_between(:'ta', :'month', :'today') as qmonth,
  (select count(*) from private.content_review(:'ta')) as review,
  private.content_snapshot(:'ta') as snapshot;
grant select on expected to authenticated;

select plan(57);

-- ── The panel's reads answer as before ─────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'analysta';
select is(public.tenant_visit_statistics(:'ta', :'month', :'today'),
  (select stats from expected), '«Estadísticas» reads the same numbers');
select is(public.tenant_unanswered_questions(:'ta', 30),
  (select q30 from expected), 'and the same questions');
select is(public.tenant_unanswered_questions_between(:'ta', :'month', :'today'),
  (select qmonth from expected), 'the questions of the month, for any member');
select is((select count(*) from public.copilot_content_review(:'ta')),
  (select review from expected), 'the content review is the same');
select is(public.copilot_snapshot(:'ta'), (select snapshot from expected), 'and the Copilot''s snapshot');
select throws_ok(format('select public.tenant_unanswered_questions_between(%L, %L, %L)', :'ta', :'month', (:'month'::date + 100)),
  '22023', null, 'a period of more than 92 days is refused');
select throws_ok(format('select public.tenant_unanswered_questions(%L, 15)', :'ta'), '22023', null,
  'the panel''s periods are still 7, 30 and 90 days');

-- ── What was published ─────────────────────────────────────────────────────
select is((public.tenant_content_activity(:'ta', :'month', :'today') ->> 'total')::integer, 2,
  'two publications this month');
select is((select (i ->> 'first')::boolean from jsonb_array_elements(public.tenant_content_activity(:'ta', :'month', :'today') -> 'items') i
           where i ->> 'title' = 'Museo'), true, 'the museum for the first time');
select is((select (i ->> 'first')::boolean from jsonb_array_elements(public.tenant_content_activity(:'ta', :'month', :'today') -> 'items') i
           where i ->> 'title' = 'Plaza'), false, 'the plaza again');
select is((public.tenant_content_activity(:'ta', :'today'::date - 61, :'today'::date - 59) ->> 'total')::integer, 1,
  'the earlier one belongs to its own days');
set local request.jwt.claims to :'ownerb';
select throws_ok(format('select public.tenant_content_activity(%L, %L, %L)', :'ta', :'month', :'today'), '42501', null,
  'another municipality cannot read it');
select throws_ok(format('select public.tenant_unanswered_questions_between(%L, %L, %L)', :'ta', :'month', :'today'), '42501', null,
  'nor the questions');

-- ── A month's report ───────────────────────────────────────────────────────
set local request.jwt.claims to :'editora';
select is(public.tenant_monthly_report(:'ta', :'month') -> 'report', 'null'::jsonb, 'an editor reads the month: no report yet');
select is(public.tenant_monthly_report(:'ta', :'month') ->> 'to', :'today', 'the current month runs to today');
select is(public.tenant_monthly_report(:'ta', (:'month'::date - interval '1 month')::date) ->> 'to',
  (:'month'::date - 1)::text, 'a past month to its last day');
select throws_ok(format('select public.tenant_monthly_report(%L, %L)', :'ta', :'next_month'), '22023', null,
  'a month in the future is refused');
select throws_ok(format('select public.tenant_monthly_report(%L, %L)', :'ta', (:'month'::date + 1)), '22023', null,
  'a month is its first day');
select throws_ok(format('select public.request_monthly_report(%L, %L)', :'ta', :'month'), '42501', null,
  'an editor cannot ask for the email');
set local request.jwt.claims to :'analysta';
select throws_ok(format('select public.request_monthly_report(%L, %L)', :'ta', :'month'), '42501', null,
  'nor an analyst');
set local request.jwt.claims to :'ownera1';
select throws_ok(format('select public.request_monthly_report(%L, %L)', :'ta', :'month'), '42501', null,
  'nor an owner without her second factor');
set local request.jwt.claims to :'ownera';
insert into ids select 'manual', public.request_monthly_report(:'ta', :'month');
select ok((select id from ids where name = 'manual') is not null, 'an owner asks for it');
select is(public.tenant_monthly_report(:'ta', :'month') ->> 'pending', 'true', 'and it is on its way');
set local request.jwt.claims to :'admina';
select lives_ok(format('select public.request_monthly_report(%L, %L)', :'ta', :'month'), 'an admin too');
select lives_ok(format('select public.request_monthly_report(%L, %L)', :'ta', (:'month'::date - interval '1 month')::date),
  'a third time, for the month before');
select throws_ok(format('select public.request_monthly_report(%L, %L)', :'ta', :'month'), 'PT429', null,
  'a fourth time today is refused');
select is((public.tenant_monthly_report(:'ta', :'month') ->> 'requestsToday')::integer, 3, 'three today');
select throws_ok('select * from public.monthly_reports', '42501', null, 'nobody reads the table directly');
reset role;
select is((select count(*)::integer from public.audit_events where action = 'report.monthly_requested' and tenant_id = :'ta'), 3,
  'each request is audited');
select is((select payload from public.background_jobs where id = (select id from ids where name = 'manual')),
  jsonb_build_object('month', :'month', 'manual', true), 'the job carries the month');
update public.tenants set status = 'provisioning' where id = :'tb';
set local role authenticated;
set local request.jwt.claims to :'ownerb';
select throws_ok(format('select public.request_monthly_report(%L, %L)', :'tb', :'month'), 'PT409', null,
  'a municipality that is not online gets none');
reset role;

-- ── The daily task ─────────────────────────────────────────────────────────
select ok(private.enqueue_monthly_reports((:'next_month'::date + interval '15 hours')::timestamptz) >= 1,
  'on the 1st, the task enqueues the month that ended');
select is((select count(*)::integer from public.background_jobs where tenant_id = :'ta' and kind = 'reports.monthly'
           and logical_key = 'monthly:' || to_char(:'month'::date, 'YYYY-MM')), 1, 'for each municipality online');
select is((select count(*)::integer from public.background_jobs where tenant_id = :'tb' and kind = 'reports.monthly'), 0,
  'not for one in preparation');
select is(private.enqueue_monthly_reports((:'next_month'::date + interval '1 day 15 hours')::timestamptz), 0,
  'only once');
select is(private.enqueue_monthly_reports((:'next_month'::date + interval '1 month 4 days 15 hours')::timestamptz), 0,
  'after the 3rd, nothing');
select lives_ok(format('select private.enqueue_monthly_reports(%L)', (:'month'::date + interval '15 hours')::timestamptz),
  'on this month''s 1st');
select is((select count(*)::integer from public.background_jobs where tenant_id = :'ta' and kind = 'reports.monthly'
           and logical_key = 'monthly:' || to_char((:'month'::date - interval '1 month')::date, 'YYYY-MM')), 0,
  'nothing for a month before the municipality existed');

-- ── The job ────────────────────────────────────────────────────────────────
update public.background_jobs set status = 'running', fencing_token = 7, lease_owner = 'runner-test', lease_until = now() + interval '1 minute'
  where id = (select id from ids where name = 'manual');
set local role rikuy_worker;
select is(worker_api.monthly_report_source((select id from ids where name = 'manual'), 7) ->> 'state', 'run', 'the job runs');
select is(worker_api.monthly_report_source((select id from ids where name = 'manual'), 7) -> 'recipients',
  '["admin.a@example.test", "owner.a@example.test"]'::jsonb, 'for owners and admins only');
select is(worker_api.monthly_report_source((select id from ids where name = 'manual'), 7) ->> 'generated', 'false',
  'nothing generated yet');
select throws_ok(format('select worker_api.monthly_report_source(%L, 8)', (select id from ids where name = 'manual')),
  'PT409', null, 'only under its lease');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(worker_api.monthly_report_data(
    (select id from ids where name = 'manual'), 7, :'month', :'today', null, null)) k),
  array['activity', 'current', 'passport', 'passportPrevious', 'previous', 'questions', 'review', 'snapshot'],
  'it reads the month''s data (with the passport, C2 · Paso 4)');
select throws_ok(format('select worker_api.monthly_report_data(%L, 7, %L, %L, null, null)',
  (select id from ids where name = 'manual'), (:'month'::date - 1), :'today'), '22023', null,
  'only of the job''s month');
select throws_ok(format('select worker_api.save_monthly_report(%L, 7, %L, %L, %L, %L, null)',
  (select id from ids where name = 'manual'), :'today', :'req_person',
  '[{"id":"H1","source":"visits","text":"El portal tuvo 12 vistas.","target":null}]',
  '[{"title":"Difunde el portal","why":"Tuvo 12 vistas.","facts":["H1"]}]'), '23514', null,
  'recommendations behind a person''s request are refused');
select throws_ok(format('select worker_api.save_monthly_report(%L, 7, %L, %L, %L, %L, null)',
  (select id from ids where name = 'manual'), :'today', :'req_b',
  '[{"id":"H1","source":"visits","text":"El portal tuvo 12 vistas.","target":null}]',
  '[{"title":"Difunde el portal","why":"Tuvo 12 vistas.","facts":["H1"]}]'), '23514', null,
  'and behind another municipality''s');
select throws_ok(format('select worker_api.save_monthly_report(%L, 7, %L, %L, %L, %L, null)',
  (select id from ids where name = 'manual'), :'today', :'req',
  '[{"id":"H1","source":"visits","text":"El portal tuvo 12 vistas.","target":null}]',
  '[{"title":"Difunde el portal","why":"Tuvo 13 vistas.","facts":["H1"]}]'), '23514', null,
  'a number its facts do not have is refused');
select throws_ok(format('select worker_api.save_monthly_report(%L, 7, %L, null, null, null, null)',
  (select id from ids where name = 'manual'), :'today'), '23514', null, 'a report without recommendations says why');
select ok(worker_api.save_monthly_report((select id from ids where name = 'manual'), 7, :'today', :'req',
  '[{"id":"H1","source":"visits","text":"El portal tuvo 12 vistas.","target":null}]',
  '[{"title":"Difunde el portal","why":"Tuvo 12 vistas.","facts":["H1"]}]', null) is not null,
  'recommendations backed by the platform''s request are kept');
select is(worker_api.mark_monthly_report_mailed((select id from ids where name = 'manual'), 7, 2), 'marked', 'the email is recorded');
select is(worker_api.mark_monthly_report_mailed((select id from ids where name = 'manual'), 7, 2), 'already_mailed', 'once');
select is(worker_api.monthly_report_source((select id from ids where name = 'manual'), 7) ->> 'mailed', 'true',
  'a retry knows it went out');
reset role;
set local role authenticated;
set local request.jwt.claims to :'analysta';
select is(public.tenant_monthly_report(:'ta', :'month') #>> '{report,mailedCount}', '2', 'any member sees it was mailed to 2');
select is(jsonb_array_length(public.tenant_monthly_report(:'ta', :'month') #> '{report,items}'), 1, 'with its recommendation');
reset role;
select is((select count(*)::integer from public.audit_events where action in ('report.monthly_generated', 'report.monthly_mailed')
  and tenant_id = :'ta'), 2, 'generating and mailing are audited');

-- ── Forgetting ─────────────────────────────────────────────────────────────
update public.monthly_reports set generated_at = now() - interval '91 days' where tenant_id = :'ta';
select is(private.forget_old_monthly_recommendations(), 1, 'after 90 days the recommendations are forgotten');
select is((select facts is null and items is null and mailed_count = 2 from public.monthly_reports where tenant_id = :'ta'), true,
  'the row keeps only when it was mailed');

select * from finish();
rollback;
