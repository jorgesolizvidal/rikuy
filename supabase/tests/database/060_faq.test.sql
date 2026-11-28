-- A · Paso 5.2 (ADR-074): the municipality's frequently asked questions. No module: every
-- municipality has them. What a draft accepts, who prepares and who publishes, that publishing
-- asks for the answer, what visitors read (the place only when it is published), «Retirar», what
-- the assistant's indexer reads, the channel metrics' citations, and the other kinds as they were.
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

-- A question as the editor writes it; each test changes one thing.
create function pg_temp.faq(p_changes jsonb default '{}')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'title', '¿Hay cajero automático?',
    'summary', 'Sí, en la plaza principal, junto a la alcaldía.',
    'body', '[]'::jsonb,
    'topic', 'services',
    'placeId', null
  ) || p_changes;
$$;

select plan(42);

select ok(has_function_privilege('anon', 'public.portal_faqs(uuid)', 'EXECUTE'), 'visitors read the questions');
select ok(not exists (select 1 from public.platform_modules where key = 'faq'), 'they are not a module');

-- ── Drafts ──────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
create temp table plaza as select * from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
select * from public.save_content_draft(:'ta', (select content_id from plaza),
  '{"title":"Plaza principal","summary":"La plaza.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}', 1);
select * from public.publish_content(:'ta', (select content_id from plaza), 2);
create temp table fair as select * from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
create temp table memory as select * from public.create_content_item(:'ta', 'story', 'la-helada', 'La helada');
set local request.jwt.claims to :'a3c';
create temp table atm as select * from public.create_content_item(:'ta', 'faq', 'hay-cajero', '¿Hay cajero automático?');
select ok((select content_id from atm) is not null, 'an editor creates a question');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from atm),
    pg_temp.faq(jsonb_build_object('placeId', (select content_id from plaza)))),
  'and saves its answer, its topic and its place'
);
select is(
  public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from atm))),
  pg_temp.faq(jsonb_build_object('placeId', (select content_id from plaza))), 'the editor reads it back as written'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from atm),
    pg_temp.faq(jsonb_build_object('placeId', (select content_id from fair)))),
  'its place may be an event'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from atm),
    pg_temp.faq(jsonb_build_object('placeId', (select content_id from memory)))),
  '23514', null, 'but not a story'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from atm),
    pg_temp.faq('{"placeId":"bbbbbbbb-0000-4000-8000-0000000000ff"}')),
  '23514', null, 'nor something that does not exist'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from atm),
    pg_temp.faq('{"topic":"food"}')),
  '23514', null, 'the topic is one of the platform''s list'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from atm),
    pg_temp.faq(jsonb_build_object('summary', E'Sí.\nEn la plaza.'))),
  '23514', null, 'the answer is one line'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from atm),
    pg_temp.faq(jsonb_build_object('summary', repeat('x', 301)))),
  '23514', null, 'of up to 300 characters'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from atm),
    pg_temp.faq('{"consent":true}')),
  '23514', null, 'a question has no other keys'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from atm),
    pg_temp.faq('{"body":[{"type":"paragraph","children":[{"type":"link","href":"javascript:alert(1)","children":[{"type":"text","text":"x"}]}]}]}')),
  '23514', null, 'its details are the allowed rich text only'
);
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 3)', :'ta', (select content_id from atm),
    pg_temp.faq(jsonb_build_object('placeId', (select content_id from plaza)))),
  'the editor puts the plaza back'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 4)', :'ta', (select content_id from atm)),
  '42501', null, 'an editor cannot publish a question'
);
select throws_ok(
  format('select public.retire_content(%L, %L)', :'ta', (select content_id from atm)),
  '42501', null, 'nor retire it'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 4)', :'ta', (select content_id from atm), pg_temp.faq()),
  '42501', null, 'an analyst cannot change it'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 4)', :'ta', (select content_id from atm), pg_temp.faq()),
  '42501', null, 'nor the owner of another municipality'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'tb', (select content_id from atm), pg_temp.faq()),
  null, null, 'not even under their own municipality'
);

-- ── Publishing: the answer ──────────────────────────────────────────────────
set local request.jwt.claims to :'a1c';
create temp table tram as select * from public.create_content_item(:'ta', 'faq', 'hay-teleferico', '¿Hay teleférico?');
select * from public.save_content_draft(:'ta', (select content_id from tram),
  pg_temp.faq('{"title":"¿Hay teleférico?","summary":"","topic":"getting_there"}'), 1);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 2)', :'ta', (select content_id from tram)),
  '23514', null, 'without its answer it is not published'
);
select is((select revision_no from public.publish_content(:'ta', (select content_id from atm), 4)), 1,
  'the owner publishes it');
create temp table bus as select * from public.create_content_item(:'ta', 'faq', 'como-llego', '¿Cómo llego?');
select * from public.save_content_draft(:'ta', (select content_id from bus),
  pg_temp.faq(jsonb_build_object('title', '¿Cómo llego?', 'summary', 'En bus desde Cliza.',
    'topic', 'getting_there', 'placeId', (select content_id from fair))), 1);
select is((select revision_no from public.publish_content(:'ta', (select content_id from bus), 2)), 1,
  'a question about an unpublished event is published too');
reset role;
select is(
  (select diff ->> 'kind' from public.audit_events where action = 'content.published' and entity_id = (select content_id from atm)),
  'faq', 'publishing it is audited'
);
grant select on atm, bus, tram, plaza, fair to authenticated, anon, rikuy_worker, rikuy_ai;

-- ── What visitors read ──────────────────────────────────────────────────────
set local role anon;
select results_eq(
  format('select slug, question, answer, topic, place_kind, place_slug, place_title from public.portal_faqs(%L)', :'ta'),
  $$values ('como-llego', '¿Cómo llego?', 'En bus desde Cliza.', 'getting_there', null::text, null::text, null::text),
           ('hay-cajero', '¿Hay cajero automático?', 'Sí, en la plaza principal, junto a la alcaldía.', 'services', 'destination', 'plaza', 'Plaza principal')$$,
  'the published questions in the order of the topics, with their place only when it is published, never the drafts'
);
select is((select count(*)::int from public.portal_faqs(:'tb')), 0, 'another municipality reads none of them');
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::int from public.portal_faqs(:'ta')), 0, 'nor anyone while it is suspended');
reset role;
update public.tenants set status = 'active' where id = :'ta';

-- An open draft does not change what visitors read until it is published.
set local role authenticated;
set local request.jwt.claims to :'a3c';
select * from public.save_content_draft(:'ta', (select content_id from atm),
  pg_temp.faq('{"summary":"Ya no hay cajero."}'), null);
set local role anon;
select is((select answer from public.portal_faqs(:'ta') where slug = 'hay-cajero'),
  'Sí, en la plaza principal, junto a la alcaldía.', 'a draft is never what visitors read');
reset role;

-- ── «Retirar» ───────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(format('select public.retire_content(%L, %L)', :'ta', (select content_id from bus)),
  'the owner retires a question');
set local role anon;
select is((select array_agg(slug) from public.portal_faqs(:'ta')), array['hay-cajero'], 'and visitors stop seeing it');
reset role;
select is(
  (select diff ->> 'kind' from public.audit_events where action = 'content.retired' and entity_id = (select content_id from bus)),
  'faq', 'retiring it is audited'
);

-- ── What the assistant's indexer reads ──────────────────────────────────────
select ok(exists (
  select 1 from public.background_jobs j
  join public.content_items i on i.id = (select content_id from atm)
  where j.kind = 'knowledge.index' and j.subject_id = i.published_revision_id
), 'publishing a question queues its indexing');
update public.background_jobs set available_at = now() + interval '1 day'
where kind = 'knowledge.index' and status = 'pending'
  and subject_id <> (select published_revision_id from public.content_items where id = (select content_id from atm));
set local role rikuy_worker;
create temp table claim as select * from worker_api.claim_jobs('runner-f', 10, array['knowledge.index']);
reset role;
create temp table atm_job as
select c.job_id, c.fencing_token from claim c
join public.background_jobs j on j.id = c.job_id
where j.subject_id = (select published_revision_id from public.content_items where id = (select content_id from atm));
grant select on atm_job to rikuy_worker;
set local role rikuy_worker;
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) -> 'faq' from atm_job),
  '{"topic":"services"}'::jsonb, 'it reads the topic'
);
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) ->> 'placeTitle' from atm_job),
  'Plaza principal', 'and the published name of its place'
);
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) ->> 'summary' from atm_job),
  'Sí, en la plaza principal, junto a la alcaldía.', 'and the answer it published, not the draft'
);
reset role;

-- ── The channel metrics resolve a citation of a question ────────────────────
select is(private.assistant_content_of(:'ta', 'faq:hay-cajero'), (select content_id from atm),
  'a citation of a question counts for the question');
select is(private.assistant_content_of(:'tb', 'faq:hay-cajero'), null,
  'never for the same address in another municipality');

-- ── The other kinds as they were ────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, null)', :'ta', (select content_id from plaza),
    '{"title":"Plaza","summary":"La plaza.","body":[],"location":null,"cover":null,"gallery":[],"topic":"services"}'),
  '23514', null, 'a destination takes none of the question''s fields'
);
select throws_ok(
  format('select * from public.create_tour(%L, %L)', :'ta', (select content_id from atm)),
  '23514', null, 'a question has no tour'
);
create temp table cut as select * from public.create_content_item(:'ta', 'notice', 'corte', 'Corte');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from cut),
    jsonb_build_object('title', 'Corte', 'summary', 'Cerrado.', 'body', '[]'::jsonb,
      'validity', '{"from":null,"until":null}'::jsonb, 'placeId', (select content_id from atm))),
  '23514', null, 'nor is it a notice''s place'
);
reset role;
select is(
  (select count(*)::int from public.content_revisions r
   where r.content_id = (select content_id from plaza) and (r.faq_topic is not null or r.faq_place_id is not null)),
  0, 'a destination never gets a topic nor a place of questions'
);
select throws_ok(
  format('update public.content_revisions set faq_topic = %L where content_id = %L', 'food', (select content_id from tram)),
  '23514', null, 'the table itself keeps only the platform''s topics'
);
select ok(not has_function_privilege('anon', 'private.is_valid_faq_draft(jsonb)', 'EXECUTE'),
  'visitors cannot call the validation');

select * from finish();
rollback;
