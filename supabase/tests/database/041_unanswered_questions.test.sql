-- C1 · Paso 3 (ADR-053): the questions the visitor's assistant could not answer. Only the AI
-- role writes them, for a recent assistant request of the same municipality; personal data is
-- masked even if the caller forgot; every member reads them grouped by their words, and
-- nobody else; they are forgotten after 90 days.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a1_aal1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set a2 '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal1"}'
\set a3 '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal1"}'
\set b1 '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set ok_call '[{"provider":"groq","model":"openai/gpt-oss-120b","status":"ok","inputTokens":120,"outputTokens":30,"latencyMs":700,"httpStatus":200}]'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'
\set place '{"title":"%s","summary":"Un lugar","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'Europe/Madrid');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'analyst', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active' where id in (:'ta', :'tb');
set constraints all immediate;
grant usage on schema extensions to rikuy_ai;

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create temp table media (tenant uuid, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (tenant) values (:'ta');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, 'panorama' from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, manifest, published_at)
select version_id, tenant, asset, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 8192, 4096, :'sha', now(), :'pano'::jsonb, now()
from media;
grant select on media to authenticated;

-- A: «Museo» published, with a tour and its scene «Sala»; B: its own «museo».
set local role authenticated;
set local request.jwt.claims to :'a1';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
select * from public.save_content_draft(:'ta', pg_temp.id('museo'), format(:'place', 'Museo')::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('museo'), 2);
insert into ids select 'T', tour_id from public.create_tour(:'ta', pg_temp.id('museo'));
insert into ids select 'sala', scene_id from public.add_tour_scene(:'ta', pg_temp.id('T'), 1, (select version_id from media), 'Sala');
select * from public.publish_tour(:'ta', pg_temp.id('T'), 2);
set local request.jwt.claims to :'b1';
insert into ids select 'museo_b', content_id from public.create_content_item(:'tb', 'destination', 'museo', 'Museo B');
reset role;

-- Assistant requests, as the gateway leaves them once answered (here, directly).
create function pg_temp.req(p_tenant uuid, p_visitor text, p_profile text default 'assistant')
returns uuid language sql as $$
  insert into public.ai_requests (tenant_id, profile, status, outcome, visitor_hash, finished_at)
  values (p_tenant, p_profile, 'completed', 'answered',
          private.ai_visitor_hash(p_tenant, p_visitor), now())
  returning id
$$;
create temp table result (name text primary key, value jsonb);
grant select, insert on result to authenticated;

select plan(39);

-- ── Who writes ──────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon',
            'ai_api.record_unanswered_question(uuid, uuid, text, text, text, text, uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated',
            'ai_api.record_unanswered_question(uuid, uuid, text, text, text, text, uuid)', 'EXECUTE')
          and not has_function_privilege('service_role',
            'ai_api.record_unanswered_question(uuid, uuid, text, text, text, text, uuid)', 'EXECUTE'),
  'visitors, members and the secret key cannot write questions');
select ok(not has_table_privilege('anon', 'public.unanswered_questions', 'SELECT')
          and not has_table_privilege('authenticated', 'public.unanswered_questions', 'SELECT')
          and not has_table_privilege('service_role', 'public.unanswered_questions', 'SELECT')
          and not has_table_privilege('rikuy_ai', 'public.unanswered_questions', 'SELECT'),
  'nobody reads the table directly, not even the AI role');
select ok(not has_function_privilege('anon', 'public.tenant_unanswered_questions(uuid, integer)', 'EXECUTE'),
  'visitors cannot read the questions');

-- Through the real gateway: reserve, answer, then record.
set local role rikuy_ai;
select request_id as g1 from ai_api.begin_request(:'ta', 'assistant', 1000, '203.0.113.7') \gset
select ai_api.finish_request(:'g1', 'answered', :'ok_call');
select is(
  ai_api.record_unanswered_question(:'ta', :'g1',
    'Mi correo es ana.perez@example.com, mi CI 1234567 LP y mi celular +591 71234567. ¿Hay   wifi?',
    'es', 'home'),
  'recorded', 'the AI role records an unanswered question of a request it just served');
reset role;
select is((select question_text from public.unanswered_questions where request_id = :'g1'),
  'Mi correo es [correo], mi CI [número] LP y mi celular +591 [número]. ¿Hay wifi?',
  'emails and long numbers are masked by the database itself, and spaces collapsed');
select is((select question_key from public.unanswered_questions where request_id = :'g1'),
  'mi correo es correo mi ci numero lp y mi celular 591 numero hay wifi',
  'its key has no case, accents or punctuation');
select is((select day from public.unanswered_questions where request_id = :'g1'),
  (now() at time zone 'America/La_Paz')::date, 'it is kept under the municipality''s day');
select is_empty(
  $$select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'unanswered_questions'
      and column_name ~* '(visitor|ip|user|actor|agent|hash|email)'$$,
  'nothing about the visitor is kept with it');

set local role rikuy_ai;
select is(ai_api.record_unanswered_question(:'ta', :'g1', '¿Otra?', 'es', 'home'), 'ignored',
  'one request records one question');
select is(ai_api.record_unanswered_question(:'tb', :'g1', '¿Hay wifi?', 'es', 'home'), 'ignored',
  'another municipality cannot use this request');
select is(ai_api.record_unanswered_question(:'ta', gen_random_uuid(), '¿Hay wifi?', 'es', 'home'), 'ignored',
  'nor an unknown request');
reset role;
select pg_temp.req(:'ta', '198.51.100.1', 'probe') as probe \gset
select pg_temp.req(:'ta', '198.51.100.1') as old \gset
update public.ai_requests set created_at = now() - interval '20 minutes' where id = :'old';
set local role rikuy_ai;
select is(ai_api.record_unanswered_question(:'ta', :'probe', '¿Hay wifi?', 'es', 'home'), 'ignored',
  'a request that is not the visitor''s assistant records nothing');
select is(ai_api.record_unanswered_question(:'ta', :'old', '¿Hay wifi?', 'es', 'home'), 'ignored',
  'nor one that is not recent');
reset role;

select pg_temp.req(:'ta', '198.51.100.2') as blank \gset
select pg_temp.req(:'ta', '198.51.100.2') as marks \gset
select pg_temp.req(:'ta', '198.51.100.2') as badlang \gset
set local role rikuy_ai;
select is(ai_api.record_unanswered_question(:'ta', :'blank', E'  \n ', 'es', 'home'), 'ignored',
  'an empty question is not kept');
select is(ai_api.record_unanswered_question(:'ta', :'marks', '¿¿??', 'es', 'home'), 'ignored',
  'nor one that is only punctuation');
select throws_ok(format($$select ai_api.record_unanswered_question(%L, %L, 'hi', 'fr', 'home')$$, :'ta', :'badlang'),
  '22023', null, 'an unknown language is refused');
select throws_ok(format($$select ai_api.record_unanswered_question(%L, %L, 'hi', 'es', 'admin')$$, :'ta', :'badlang'),
  '22023', null, 'and an unknown page');
reset role;

-- Where it was asked: the place of this municipality and the scene of its tour.
select pg_temp.id('sala') as sala \gset
select pg_temp.req(:'ta', '198.51.100.3') as onplace \gset
select pg_temp.req(:'ta', '198.51.100.3') as onscene \gset
select pg_temp.req(:'ta', '198.51.100.3') as otherscene \gset
select pg_temp.req(:'ta', '198.51.100.3') as unknownplace \gset
select pg_temp.req(:'ta', '198.51.100.3') as long \gset
set local role rikuy_ai;
select ai_api.record_unanswered_question(:'ta', :'onplace', '¿Cuánto cuesta la entrada?', 'es', 'destination', 'museo');
select ai_api.record_unanswered_question(:'ta', :'onscene', '¿Qué estoy viendo?', 'es', 'destination_tour', 'museo', :'sala');
select ai_api.record_unanswered_question(:'ta', :'otherscene', '¿Qué estoy viendo?', 'es', 'destination_tour', 'museo', gen_random_uuid());
select ai_api.record_unanswered_question(:'ta', :'unknownplace', 'What time does it open?', 'en', 'destination', 'no-existe');
select ai_api.record_unanswered_question(:'ta', :'long', repeat('palabra ', 100), 'es', 'other');
reset role;
select is((select content_id from public.unanswered_questions where request_id = :'onplace'), pg_temp.id('museo'),
  'a question on a place''s page keeps the place');
select is((select array[content_id, scene_id] from public.unanswered_questions where request_id = :'onscene'),
  array[pg_temp.id('museo'), pg_temp.id('sala')], 'one inside its tour keeps the scene');
select is((select scene_id from public.unanswered_questions where request_id = :'otherscene'), null::uuid,
  'a scene that tour does not have is dropped');
select is((select content_id from public.unanswered_questions where request_id = :'unknownplace'), null::uuid,
  'and a place that does not exist');
select is((select char_length(question_text) from public.unanswered_questions where request_id = :'long'), 500,
  'a long question is cut at 500 characters');

select throws_ok(
  format($$insert into public.unanswered_questions (tenant_id, request_id, day, question_text, question_key, lang, page_kind)
           values (%L, %L, current_date, 'escribe a ana@example.com', 'x', 'es', 'home')$$, :'ta', pg_temp.req(:'ta', 'x')),
  '23514', null, 'the table itself refuses an email');
select throws_ok(
  format($$insert into public.unanswered_questions (tenant_id, request_id, day, question_text, question_key, lang, page_kind)
           values (%L, %L, current_date, 'mi CI 1234567', 'x', 'es', 'home')$$, :'ta', pg_temp.req(:'ta', 'y')),
  '23514', null, 'and a long number');

-- ── Grouping and reading ────────────────────────────────────────────────────
-- «¿Hay wifi?» three more times: two people, one of them twice, with other case and accents.
select pg_temp.req(:'ta', '203.0.113.8') as w1 \gset
select pg_temp.req(:'ta', '203.0.113.8') as w2 \gset
select pg_temp.req(:'ta', '203.0.113.9') as w3 \gset
select pg_temp.req(:'ta', '203.0.113.9') as before \gset
select pg_temp.req(:'tb', '203.0.113.9') as inb \gset
set local role rikuy_ai;
select ai_api.record_unanswered_question(:'ta', :'w1', 'hay wifi', 'es', 'home');
select ai_api.record_unanswered_question(:'ta', :'w2', '¿HAY WIFÍ?', 'es', 'map');
select ai_api.record_unanswered_question(:'ta', :'w3', 'Hay wifi!', 'es', 'map');
select ai_api.record_unanswered_question(:'ta', :'before', '¿Hay cajero automático?', 'es', 'home');
select ai_api.record_unanswered_question(:'tb', :'inb', '¿Hay wifi?', 'es', 'home');
reset role;
-- One asked 40 days ago (in the 90-day period, not in the 30-day one).
update public.unanswered_questions
set day = day - 40, asked_at = asked_at - interval '40 days'
where request_id = :'before';

set local role authenticated;
set local request.jwt.claims to :'a1';
insert into result select 'd30', public.tenant_unanswered_questions(:'ta', 30);
insert into result select 'd90', public.tenant_unanswered_questions(:'ta', 90);
set local request.jwt.claims to :'a2';
select lives_ok(format($$select public.tenant_unanswered_questions(%L, 7)$$, :'ta'), 'an analyst reads them');
set local request.jwt.claims to :'a3';
select lives_ok(format($$select public.tenant_unanswered_questions(%L, 7)$$, :'ta'), 'and an editor');
set local request.jwt.claims to :'a1_aal1';
select throws_ok(format($$select public.tenant_unanswered_questions(%L, 7)$$, :'ta'), '42501', null,
  'an owner without the second factor does not (ADR-043)');
set local request.jwt.claims to :'b1';
select throws_ok(format($$select public.tenant_unanswered_questions(%L, 7)$$, :'ta'), '42501', null,
  'nor the owner of another municipality');
set local request.jwt.claims to :'a1';
select throws_ok(format($$select public.tenant_unanswered_questions(%L, 14)$$, :'ta'), '22023', null,
  'only 7, 30 or 90 days');
reset role;

select is((select value -> 'groups' -> 0 ->> 'key' from result where name = 'd30'), 'hay wifi',
  'the most asked comes first');
select is((select array[(value -> 'groups' -> 0 ->> 'times')::int, (value -> 'groups' -> 0 ->> 'people')::int]
           from result where name = 'd30'), array[3, 2],
  'the same words with other case, accents and marks group together, with how many people');
select is((select value -> 'groups' -> 0 ->> 'text' from result where name = 'd30'), 'Hay wifi!',
  'with the newest wording');
select is((select value -> 'groups' -> 0 -> 'pages' -> 0 ->> 'pageKind' from result where name = 'd30'), 'map',
  'and the page it was asked on most');
select is(
  (select g -> 'pages' -> 0 ->> 'sceneTitle' from result, jsonb_array_elements(value -> 'groups') g
   where name = 'd30' and g ->> 'key' = 'que estoy viendo'),
  'Sala', 'a scene comes with its name, and its place''s');
select ok(
  (select bool_and(g ->> 'key' <> 'hay cajero automatico') from result, jsonb_array_elements(value -> 'groups') g
   where name = 'd30')
  and (select bool_or(g ->> 'key' = 'hay cajero automatico') from result, jsonb_array_elements(value -> 'groups') g
       where name = 'd90'),
  'a question from 40 days ago is in the last 90 days, not in the last 30');
select is((select (value ->> 'total')::int from result where name = 'd30'), 9,
  'only this municipality''s questions count');

-- ── Forgetting ──────────────────────────────────────────────────────────────
update public.unanswered_questions set asked_at = now() - interval '91 days' where request_id = :'before';
select private.forget_unanswered_questions();
select ok(not exists (select 1 from public.unanswered_questions where request_id = :'before')
          and exists (select 1 from public.unanswered_questions where request_id = :'w1'),
  'after 90 days a question is forgotten, and the newer ones stay');
delete from public.ai_requests where id = :'w1';
select ok(not exists (select 1 from public.unanswered_questions where request_id = :'w1'),
  'and it goes with its request');
select is((select count(*)::int from cron.job where jobname = 'rikuy-forget-unanswered-questions'), 1,
  'forgetting runs every day');

select * from finish();
rollback;
