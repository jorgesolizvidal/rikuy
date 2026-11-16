-- A · Paso 1.1 (ADR-069): the municipality's notices. Validity and place in the draft, who
-- prepares and who publishes, what publishing asks for, and — the step's criterion — that a
-- notice that ended is used nowhere: not by the assistant's search, not as a place's notice,
-- not by the portal, without anyone unpublishing it.
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
-- The seed's own indexing jobs stay out of these claims.
update public.background_jobs set available_at = now() + interval '1 day'
where kind = 'knowledge.index' and status = 'pending';

grant usage on schema extensions to rikuy_worker, rikuy_ai;
do $$ begin execute format('grant temporary on database %I to rikuy_worker, rikuy_ai', current_database()); end $$;

-- Local minutes in the municipality's time zone, as the editor writes them.
create temp table v as
select to_char(n - interval '1 day', 'YYYY-MM-DD"T"HH24:MI') as yesterday,
       to_char(n + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI') as in2h,
       to_char(n + interval '2 days', 'YYYY-MM-DD"T"HH24:MI') as in2d,
       to_char(n + interval '10 days', 'YYYY-MM-DD"T"HH24:MI') as in10d,
       to_char(n + interval '30 days', 'YYYY-MM-DD"T"HH24:MI') as in30d,
       to_char(n + interval '91 days', 'YYYY-MM-DD"T"HH24:MI') as in91d,
       to_char(n + interval '95 days', 'YYYY-MM-DD"T"HH24:MI') as in95d
from (select date_trunc('minute', now() at time zone 'America/La_Paz') as n) x;
grant select on v to authenticated, anon, rikuy_ai, rikuy_worker;

create function pg_temp.notice(p_summary text, p_from text, p_until text, p_place uuid)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'title', 'Aviso', 'summary', p_summary, 'body', '[]'::jsonb,
    'validity', jsonb_build_object('from', p_from, 'until', p_until),
    'placeId', p_place);
$$;

-- Stands in for the indexer: one chunk per claimed job, with the revision's summary.
create function pg_temp.index_claimed(p_claims regclass)
returns void
language plpgsql
as $$
declare
  v_claim record;
  v_title text;
  v_text text;
begin
  for v_claim in execute format('select job_id, fencing_token from %s', p_claims) loop
    select r.title, r.summary into v_title, v_text
    from public.background_jobs j
    join public.content_revisions r on j.subject_type = 'content_revision' and r.id = j.subject_id
    where j.id = v_claim.job_id;
    if v_title is null then
      perform worker_api.complete_job(v_claim.job_id, v_claim.fencing_token, '{"outcome":"skipped"}', '{}');
      continue;
    end if;
    perform worker_api.store_knowledge_chunks(
      v_claim.job_id, v_claim.fencing_token, 1, v_title,
      jsonb_build_array(jsonb_build_object(
        'chunkNo', 0, 'heading', null, 'body', coalesce(nullif(v_text, ''), v_title),
        'pageFrom', null, 'pageTo', null, 'sceneId', null, 'hotspotId', null, 'sha256', repeat('a', 64)))
    );
    perform worker_api.complete_job(v_claim.job_id, v_claim.fencing_token, '{"outcome":"stored"}', '{}');
  end loop;
end;
$$;

select plan(54);

-- ── Structure and privileges ────────────────────────────────────────────────
select has_column('public', 'content_revisions', 'notice_until_local', 'a revision has the notice''s end');
select ok(has_function_privilege('anon', 'public.portal_notices(uuid)', 'EXECUTE'), 'visitors read the notices in force');
select ok(has_function_privilege('rikuy_ai', 'ai_api.place_notices(uuid, text, text)', 'EXECUTE'), 'the AI role reads a place''s notices');
select ok(not has_function_privilege('authenticated', 'ai_api.place_notices(uuid, text, text)', 'EXECUTE'), 'members do not');
select ok(not has_function_privilege('anon', 'ai_api.place_notices(uuid, text, text)', 'EXECUTE'), 'nor visitors');

-- ── Validity ────────────────────────────────────────────────────────────────
select is(
  (select count(*)::int from private.parse_notice_validity('{"from":"2026-12-01T08:00","until":"2026-12-03T18:00"}')),
  1, 'a «desde» and a «hasta» are a validity'
);
select is(
  (select count(*)::int from private.parse_notice_validity('{"from":null,"until":null}')),
  1, 'a draft may have neither yet'
);
select is(
  (select count(*)::int from private.parse_notice_validity('{"from":"2026-12-03T08:00","until":"2026-12-01T08:00"}')),
  0, '«hasta» before «desde» is refused'
);
select is(
  (select count(*)::int from private.parse_notice_validity('{"from":"2026-12-01T08:00","until":"2027-03-02T08:00"}')),
  0, 'more than 90 days is refused'
);
select is(
  (select count(*)::int from private.parse_notice_validity('{"from":null,"until":"2026-02-30T10:00"}')),
  0, 'a day that does not exist is refused'
);
select is(
  (select count(*)::int from private.parse_notice_validity('{"from":null,"until":"2026-12-01T24:00"}')),
  0, '24:00 is refused'
);
select is(
  (select count(*)::int from private.parse_notice_validity('{"from":null,"until":"2026-12-01","extra":1}')),
  0, 'other keys or formats are refused'
);

-- ── Places and drafts ───────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
create temp table place as select * from public.create_content_item(:'ta', 'destination', 'puente-viejo', 'Puente viejo');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from place),
    '{"title":"Puente viejo","summary":"Un puente.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'),
  'destinations still save as before'
);
select is((select revision_no from public.publish_content(:'ta', (select content_id from place), 2)), 1, 'and publish');
create temp table kn as select * from public.create_content_item(:'ta', 'knowledge', 'guia', 'Guía');
reset role;
grant select on place, kn to authenticated, rikuy_ai;
set local role authenticated;
set local request.jwt.claims to :'b1c';
create temp table other as select * from public.create_content_item(:'tb', 'destination', 'puente-viejo', 'Puente viejo');
reset role;
grant select on other to authenticated, rikuy_ai;

set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table cut as select * from public.create_content_item(:'ta', 'notice', 'corte-de-ruta', 'Corte de ruta');
select ok((select content_id from cut) is not null, 'an editor creates a notice');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from cut),
    pg_temp.notice('Corte de ruta por obras en el puente.', null, null, null)),
  'and saves a draft that has no end yet'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from cut),
    pg_temp.notice('Corte.', null, (select in2d from v), null) || '{"categoryId":null}'),
  '23514', null, 'a notice has no category or other keys'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from cut),
    pg_temp.notice('Corte.', null, (select in2d from v), (select content_id from other))),
  '23514', null, 'a place of another municipality is refused'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from cut),
    pg_temp.notice('Corte.', null, (select in2d from v), (select content_id from kn))),
  '23514', null, 'a place is a destination or an event, never knowledge'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from cut),
    pg_temp.notice('Corte de ruta por obras en el puente.', null, (select in2d from v), (select content_id from place))),
  'the notice names the bridge and ends in two days'
);
select is(
  public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from cut))) #>> '{validity,until}',
  (select in2d from v), 'the editor reads back its end as written'
);
select is(
  (public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from cut))) ->> 'placeId')::uuid,
  (select content_id from place), 'and its place'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 3)', :'ta', (select content_id from cut)),
  '42501', null, 'an editor cannot publish a notice'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from cut),
    pg_temp.notice('Corte.', null, (select in2d from v), null)),
  '42501', null, 'an analyst cannot change it'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.publish_content(%L, %L, 3)', :'ta', (select content_id from cut)),
  '42501', null, 'nor the owner of another municipality'
);

-- ── Publishing asks for its text and an end still to come ───────────────────
set local request.jwt.claims to :'a1c';
create temp table late as select * from public.create_content_item(:'ta', 'notice', 'feria-suspendida', 'Feria suspendida');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from late),
    pg_temp.notice('La feria del domingo se suspende.', null, null, null)),
  'the owner prepares another one without an end'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 2)', :'ta', (select content_id from late)),
  '23514', null, 'a notice without an end is not published'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from late),
    pg_temp.notice('La feria del domingo se suspende.', null, (select yesterday from v), null)),
  'an end that already passed can be saved'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 3)', :'ta', (select content_id from late)),
  '23514', null, 'but not published'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from late),
    pg_temp.notice('La feria del domingo se suspende.', null, (select in91d from v), null)),
  'an end in 91 days can be saved without a start'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 4)', :'ta', (select content_id from late)),
  '23514', null, 'but it would last more than 90 days from now'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 4)', :'ta', (select content_id from late),
    pg_temp.notice('La feria del domingo se suspende.', (select in10d from v), (select in95d from v), null)),
  'starting in 10 days, it ends in 95'
);
select is(
  (select revision_no from public.publish_content(:'ta', (select content_id from late), 5)), 1,
  'and is published, programmed (85 days from its start)'
);
select is(
  (select revision_no from public.publish_content(:'ta', (select content_id from cut), 3)), 1,
  'the owner publishes the road cut'
);
create temp table soon as select * from public.create_content_item(:'ta', 'notice', 'cambio-de-horario', 'Cambio de horario');
create temp table soon_saved as select * from public.save_content_draft(:'ta', (select content_id from soon),
  pg_temp.notice('El museo abre a las 10 desde hoy.', (select in2h from v), (select in30d from v), null), 1);
select is((select revision_no from public.publish_content(:'ta', (select content_id from soon), 2)), 1,
  'another one starts in two hours');

-- ── The portal: what is in force, and what starts within a day ───────────────
set local role anon;
select is(
  (select array_agg(slug order by slug) from public.portal_notices(:'ta')),
  array['cambio-de-horario', 'corte-de-ruta'],
  'visitors get the notice in force and the one that starts today, not the one in 10 days'
);
select is(
  (select place_slug || ' · ' || place_title from public.portal_notices(:'ta') where slug = 'corte-de-ruta'),
  'puente-viejo · Puente viejo', 'with its published place'
);
select ok(
  (select starts_at > now() from public.portal_notices(:'ta') where slug = 'cambio-de-horario'),
  'and the instants the browser compares (the change has not started)'
);
select is((select count(*)::int from public.portal_notices(:'tb')), 0, 'another municipality sees none of them');

-- ── The assistant ───────────────────────────────────────────────────────────
reset role;
set local role rikuy_worker;
create temp table i1 as select * from worker_api.claim_jobs('runner-n', 10, array['knowledge.index']);
reset role;
create temp table cut_job as
select c.job_id, c.fencing_token
from i1 c
join public.background_jobs j on j.id = c.job_id
join public.content_items i on i.published_revision_id = j.subject_id
where i.slug = 'corte-de-ruta';
grant select on cut_job to rikuy_worker;
set local role rikuy_worker;
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) ->> 'placeTitle' from cut_job),
  'Puente viejo', 'the indexer reads the notice''s place in words'
);
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) #>> '{validity,until}' from cut_job),
  (select in2d from v), 'and its validity'
);
reset role;
grant select on i1 to postgres;
select pg_temp.index_claimed('i1');

set local role authenticated;
set local request.jwt.claims to :'a4c';
select is(
  (select kind::text from public.search_tenant_knowledge(:'ta', '¿Está cortado el puente?') limit 1),
  'notice', 'the notice in force comes first'
);
select is(
  (select count(*)::int from public.search_tenant_knowledge(:'ta', 'feria domingo suspende')), 0,
  'the one that has not started is never found'
);
reset role;
set local role rikuy_ai;
select is(
  (select slug from ai_api.place_notices(:'ta', 'destination', 'puente-viejo')),
  'corte-de-ruta', 'the bridge''s page brings its notice'
);
select is((select count(*)::int from ai_api.place_notices(:'tb', 'destination', 'puente-viejo')), 0,
  'the same address in another municipality brings nothing');
select is((select count(*)::int from ai_api.place_notices(:'ta', 'knowledge', 'guia')), 0,
  'only destinations and events have notices');

-- ── When it ends: used nowhere, without unpublishing it ─────────────────────
reset role;
set local session_replication_role = replica;
update public.content_revisions r
set notice_until_local = date_trunc('minute', now() at time zone 'America/La_Paz') - interval '1 minute'
where r.id = (select published_revision_id from public.content_items where id = (select content_id from cut));
set local session_replication_role = origin;

set local role authenticated;
set local request.jwt.claims to :'a4c';
select is((select count(*)::int from public.search_tenant_knowledge(:'ta', 'puente cortado obras')), 1,
  'a notice that ended is no longer found (only the bridge itself)');
reset role;
set local role rikuy_ai;
select is((select count(*)::int from ai_api.place_notices(:'ta', 'destination', 'puente-viejo')), 0,
  'nor brought by the bridge''s page');
reset role;
set local role anon;
select is((select array_agg(slug) from public.portal_notices(:'ta')), array['cambio-de-horario'],
  'nor shown by the portal');
reset role;
select ok(
  (select published_revision_id is not null from public.content_items where id = (select content_id from cut)),
  'and it is still published: nobody had to unpublish it'
);

-- ── Retire ──────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
select throws_ok(
  format('select public.retire_content(%L, %L)', :'ta', (select content_id from soon)),
  '42501', null, 'an editor cannot retire a notice'
);
set local request.jwt.claims to :'a1c';
select lives_ok(
  format('select public.retire_content(%L, %L)', :'ta', (select content_id from soon)),
  'the owner retires the change of hours («ya no aplica»)'
);
select throws_ok(
  format('select public.retire_content(%L, %L)', :'ta', (select content_id from place)),
  '23514', null, 'destinations are still not retired'
);
reset role;
set local role anon;
select is((select count(*)::int from public.portal_notices(:'ta')), 0, 'the portal stops showing it at once');

select * from finish();
rollback;
