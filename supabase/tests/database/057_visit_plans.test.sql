-- A · Paso 3 (ADR-072): the visit time and «for children» of destinations and events. What a
-- draft accepts, what the editor reads back, that they are sealed with the revision, what the
-- indexer says in words and what visitors read for the plans.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;
-- The seed's own indexing jobs stay out of the claim below.
update public.background_jobs set available_at = now() + interval '1 day'
where kind = 'knowledge.index' and status = 'pending';
grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

-- A destination as the editor writes it; each test changes one thing.
create function pg_temp.place(p_changes jsonb default '{}')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'title', 'Museo del valle',
    'summary', 'Herramientas y fotos antiguas.',
    'body', '[]'::jsonb,
    'location', '{"lat":-17.39,"lng":-66.15}'::jsonb,
    'cover', null,
    'gallery', '[]'::jsonb,
    'visitMinutes', 90,
    'kids', true
  ) || p_changes;
$$;

-- An event as the editor writes it (in a month, so it never ends during the test).
create function pg_temp.event(p_changes jsonb default '{}')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'title', 'Feria del valle',
    'summary', 'Comida y música.',
    'body', '[]'::jsonb,
    'schedule', jsonb_build_object('allDay', true,
      'start', to_char(now() + interval '30 days', 'YYYY-MM-DD'),
      'end', to_char(now() + interval '30 days', 'YYYY-MM-DD')),
    'venueId', null,
    'location', '{"lat":-17.39,"lng":-66.15}'::jsonb,
    'cover', null,
    'gallery', '[]'::jsonb,
    'kids', false
  ) || p_changes;
$$;

create function pg_temp.saves(p_content uuid, p_document jsonb)
returns boolean
language plpgsql
as $$
begin
  perform public.save_content_draft(
    'aaaaaaaa-0000-4000-8000-000000000001', p_content, p_document,
    (select r.edit_count from public.content_items i
     join public.content_revisions r on r.id = i.draft_revision_id where i.id = p_content));
  return true;
exception when others then
  return false;
end;
$$;

-- The draft's current edit number (publishing asks for it).
create function pg_temp.edit(p_content uuid)
returns integer
language sql
as $$
  select r.edit_count from public.content_items i
  join public.content_revisions r on r.id = i.draft_revision_id where i.id = p_content;
$$;

select plan(30);

-- ── Destinations ────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table museum as select * from public.create_content_item(:'ta', 'destination', 'museo-del-valle', 'Museo del valle');
select ok(
  pg_temp.saves((select content_id from museum), pg_temp.place()),
  'an editor saves a destination with its visit time and «for children»'
);
select is(
  public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from museum))),
  pg_temp.place(), 'and reads them back as written'
);
select ok(pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":15,"kids":false}')),
  '15 minutes and «not recommended» are accepted');
select ok(pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":240,"kids":null}')),
  '4 hours and «not said» are accepted');
select ok(not pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":10}')),
  'less than 15 minutes is refused');
select ok(not pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":245}')),
  'more than 4 hours is refused');
select ok(not pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":47}')),
  'minutes go in steps of 5');
select ok(not pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":45.5}')),
  'whole minutes only');
select ok(not pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":"45"}')),
  'a number, not a text');
select ok(not pg_temp.saves((select content_id from museum), pg_temp.place('{"kids":"si"}')),
  '«for children» is true, false or null');

select ok(pg_temp.saves((select content_id from museum), pg_temp.place() - 'visitMinutes' - 'kids'),
  'both are optional');
select is(
  public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from museum))),
  pg_temp.place() - 'visitMinutes' - 'kids',
  'and without them the editor''s document is as before (the panel already deployed keeps working)'
);
select ok(pg_temp.saves((select content_id from museum), pg_temp.place()), 'saved again with both');

-- ── Events: «for children», never a visit time ─────────────────────────────
create temp table fair as select * from public.create_content_item(:'ta', 'event', 'feria-del-valle', 'Feria del valle');
select ok(pg_temp.saves((select content_id from fair), pg_temp.event()), 'an event saves «for children»');
select is(
  public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from fair))) ->> 'kids',
  'false', 'and reads it back'
);
select ok(not pg_temp.saves((select content_id from fair), pg_temp.event('{"visitMinutes":60}')),
  'an event has no visit time');

-- ── Who changes them ────────────────────────────────────────────────────────
set local request.jwt.claims to :'a4c';
select ok(not pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":30}')),
  'an analyst does not change them');
set local request.jwt.claims to :'b1c';
select ok(not pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":30}')),
  'the owner of another municipality does not either');

-- ── Publishing seals them ───────────────────────────────────────────────────
set local request.jwt.claims to :'a1c';
select is((select revision_no from public.publish_content(:'ta', (select content_id from museum), pg_temp.edit((select content_id from museum)))), 1,
  'the owner publishes the destination');
reset role;
select is(
  (select array[r.visit_minutes::integer, case when r.kids_suitable then 1 else 0 end]
   from public.content_items i join public.content_revisions r on r.id = i.published_revision_id
   where i.id = (select content_id from museum)),
  array[90, 1], 'the published revision keeps them'
);
select throws_ok(
  format('update public.content_revisions set visit_minutes = 30 where id = %L',
    (select published_revision_id from public.content_items where id = (select content_id from museum))),
  '23514', null, 'and they cannot change once sealed'
);
select throws_ok(
  format('update public.content_revisions set visit_minutes = 47 where id = %L',
    (select draft_revision_id from public.content_items where id = (select content_id from fair))),
  '23514', null, 'the table refuses a visit time out of steps'
);

-- ── The indexer says them in words ───────────────────────────────────────────
set local role rikuy_worker;
create temp table jobs as select * from worker_api.claim_jobs('runner-v', 10, array['knowledge.index']);
grant select on jobs to postgres;
reset role;
create temp table museum_job as
select c.job_id, c.fencing_token
from jobs c
join public.background_jobs j on j.id = c.job_id
where j.subject_id = (select published_revision_id from public.content_items where id = (select content_id from museum));
grant select on museum_job to rikuy_worker;
set local role rikuy_worker;
select is(
  (select (worker_api.knowledge_source(job_id, fencing_token) ->> 'visitMinutes')::integer from museum_job),
  90, 'the indexer reads the visit time'
);
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) ->> 'kids' from museum_job),
  'true', 'and «for children»'
);
reset role;

-- ── What visitors read for the plans ──────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is((select revision_no from public.publish_content(:'ta', (select content_id from fair), pg_temp.edit((select content_id from fair)))), 1,
  'the owner publishes the event');
set local role anon;
select results_eq(
  format('select kind, slug, visit_minutes, kids from public.portal_plan_traits(%L)', :'ta'),
  $$ values ('destination'::text, 'museo-del-valle'::text, 90, true), ('event', 'feria-del-valle', null::integer, false) $$,
  'visitors read the visit time and «for children» of what is published'
);
select is((select count(*)::int from public.portal_plan_traits(:'tb')), 0, 'nothing of another municipality');

-- A new draft does not change what visitors read until it is published.
reset role;
set local role authenticated;
set local request.jwt.claims to :'a3c';
select ok(pg_temp.saves((select content_id from museum), pg_temp.place('{"visitMinutes":30,"kids":false}')),
  'an editor drafts other values');
set local role anon;
select is(
  (select visit_minutes from public.portal_plan_traits(:'ta') where slug = 'museo-del-valle'),
  90, 'visitors still read the published ones'
);

reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::int from public.portal_plan_traits(:'ta')), 0, 'nothing of a suspended municipality');

reset role;
select * from finish();
rollback;
