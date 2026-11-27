-- A · Paso 4 (ADR-073): «Hablar con una persona». The brand accepts «Atención al visitante»;
-- only the AI role marks a question «pidió una persona», for a request of this municipality's
-- assistant of the last hour and of the same visitor; the unanswered questions keep meaning
-- «sin respuesta»; every member reads the questions taken to a person, and nobody else.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a1_aal1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set a2 '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal1"}'
\set b1 '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set brand '{"identity":{"siteName":"Tenant A","shortName":"A","tagline":""},"theme":{"mode":"light","brand":"#1f6f4a","accent":"#a06f12"},"contact":{},"social":[],"seo":{"description":""}}'
\set weekly '{"mode":"weekly","days":[[["08:00","12:00"],["14:00","18:00"]],[["08:00","18:00"]],[["08:00","18:00"]],[["08:00","18:00"]],[["08:00","18:00"]],[],[]],"note":"Feriados cerrado"}'
\set place '{"title":"%s","summary":"Un lugar","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'Europe/Madrid');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active' where id in (:'ta', :'tb');
set constraints all immediate;
grant usage on schema extensions to rikuy_ai;

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;

set local role authenticated;
set local request.jwt.claims to :'a1';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
select * from public.save_content_draft(:'ta', pg_temp.id('museo'), format(:'place', 'Museo')::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('museo'), 2);
reset role;

-- Assistant requests as the gateway leaves them (here, directly), with the visitor's print.
create function pg_temp.req(p_tenant uuid, p_visitor text, p_profile text default 'assistant')
returns uuid language sql as $$
  insert into public.ai_requests (tenant_id, profile, status, outcome, visitor_hash, finished_at)
  values (p_tenant, p_profile, 'completed', 'answered',
          case when p_visitor is null then null else private.ai_visitor_hash(p_tenant, p_visitor) end,
          now())
  returning id
$$;
create temp table result (name text primary key, value jsonb);
grant select, insert on result to authenticated;

select plan(39);

-- ── «Atención al visitante» in the brand ───────────────────────────────────
select ok(private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}',
            '{"name":"Oficina de turismo"}')),
  'a help desk with only its name is valid (the phone and the email stay the portal''s)');
select ok(private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}',
            jsonb_build_object('name', 'Oficina de turismo', 'whatsapp', '+591 71234567',
                               'hours', :'weekly'::jsonb))),
  'with an international WhatsApp and opening hours');
select ok(private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}',
            '{"name":"Oficina","hours":{"mode":"always","note":""}}')),
  'or open always');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}', '{"whatsapp":"+591 71234567"}')),
  'it needs a name');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}', '{"name":""}')),
  'not an empty one');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}', jsonb_build_object('name', repeat('a', 61)))),
  'of up to 60 characters');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}', jsonb_build_object('name', E'Oficina\nde turismo'))),
  'in one line');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}', '{"name":"Oficina","whatsapp":"71234567"}')),
  'a WhatsApp without the country code is refused');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}', '{"name":"Oficina","whatsapp":71234567}')),
  'and one that is not text');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}', '{"name":"Oficina","hours":{"mode":"weekly","days":[],"note":""}}')),
  'and hours that are not valid');
select ok(not private.is_valid_presentation(jsonb_set(:'brand'::jsonb, '{helpDesk}', '{"name":"Oficina","email":"x@example.test"}')),
  'and any other key');
set local role authenticated;
set local request.jwt.claims to :'a1';
select lives_ok(format($$select public.save_tenant_config_draft(%L, %L::jsonb, null)$$, :'ta',
  jsonb_set(:'brand'::jsonb, '{helpDesk}', '{"name":"Oficina de turismo","whatsapp":"+591 71234567"}')),
  'an owner saves it in the brand');
select throws_ok(format($$select public.save_tenant_config_draft(%L, %L::jsonb, null)$$, :'ta',
  jsonb_set(:'brand'::jsonb, '{helpDesk}', '{"name":"Oficina","whatsapp":"71234567"}')),
  '23514', null, 'and the database refuses an invalid one');
reset role;

-- ── Who marks ───────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon',
            'ai_api.record_person_request(uuid, uuid, text, text, text, text, text, uuid)', 'EXECUTE')
          and not has_function_privilege('authenticated',
            'ai_api.record_person_request(uuid, uuid, text, text, text, text, text, uuid)', 'EXECUTE')
          and not has_function_privilege('service_role',
            'ai_api.record_person_request(uuid, uuid, text, text, text, text, text, uuid)', 'EXECUTE'),
  'visitors, members and the secret key cannot mark a question');
select ok(not has_function_privilege('anon', 'public.tenant_person_requests(uuid, integer)', 'EXECUTE'),
  'visitors cannot read them');

-- An answered question, taken to a person by the same visitor.
select pg_temp.req(:'ta', '203.0.113.7') as answered \gset
set local role rikuy_ai;
select is(ai_api.record_person_request(:'ta', :'answered', '203.0.113.7',
    'Mi correo es ana@example.com. ¿El museo abre el domingo?', 'es', 'destination', 'museo'),
  'recorded', 'the AI role keeps the question the visitor took to a person');
reset role;
select is(
  (select array[question_text, answered::text, (asked_person_at is not null)::text, (content_id = pg_temp.id('museo'))::text]
   from public.unanswered_questions where request_id = :'answered'),
  array['Mi correo es [correo]. ¿El museo abre el domingo?', 'true', 'true', 'true'],
  'masked, marked answered and «pidió una persona», with its page');

select pg_temp.req(:'ta', '203.0.113.7') as other \gset
select pg_temp.req(:'ta', '203.0.113.7', 'probe') as probe \gset
select pg_temp.req(:'ta', '203.0.113.7') as old \gset
update public.ai_requests set created_at = now() - interval '61 minutes' where id = :'old';
select pg_temp.req(:'ta', '203.0.113.7') as recent \gset
update public.ai_requests set created_at = now() - interval '50 minutes' where id = :'recent';
select pg_temp.req(:'ta', '203.0.113.7') as blank \gset
set local role rikuy_ai;
select is(ai_api.record_person_request(:'ta', :'other', '198.51.100.9', '¿Hay wifi?', 'es', 'home'), 'ignored',
  'another visitor cannot use someone else''s answer');
select is(ai_api.record_person_request(:'ta', :'other', null, '¿Hay wifi?', 'es', 'home'), 'ignored',
  'nor someone without a visitor key');
select is(ai_api.record_person_request(:'tb', :'other', '203.0.113.7', '¿Hay wifi?', 'es', 'home'), 'ignored',
  'nor another municipality');
select is(ai_api.record_person_request(:'ta', gen_random_uuid(), '203.0.113.7', '¿Hay wifi?', 'es', 'home'), 'ignored',
  'nor an unknown request');
select is(ai_api.record_person_request(:'ta', :'probe', '203.0.113.7', '¿Hay wifi?', 'es', 'home'), 'ignored',
  'a request that is not the visitor''s assistant marks nothing');
select is(ai_api.record_person_request(:'ta', :'old', '203.0.113.7', '¿Hay wifi?', 'es', 'home'), 'ignored',
  'nor one of more than an hour ago');
select is(ai_api.record_person_request(:'ta', :'recent', '203.0.113.7', '¿Hay wifi?', 'es', 'home'), 'recorded',
  'one of 50 minutes ago does');
select is(ai_api.record_person_request(:'ta', :'blank', '203.0.113.7', E'  \n ', 'es', 'home'), 'ignored',
  'an empty question is not kept');
select throws_ok(format($$select ai_api.record_person_request(%L, %L, '203.0.113.7', 'hi', 'fr', 'home')$$, :'ta', :'blank'),
  '22023', null, 'an unknown language is refused');
reset role;

-- An unanswered question, then taken to a person: only the mark.
select pg_temp.req(:'ta', '203.0.113.8') as unanswered \gset
set local role rikuy_ai;
select ai_api.record_unanswered_question(:'ta', :'unanswered', '¿Hay cajero automático?', 'es', 'home');
select is(ai_api.record_person_request(:'ta', :'unanswered', '203.0.113.8', 'otro texto', 'es', 'map'), 'recorded',
  'an unanswered question taken to a person is marked');
reset role;
select is(
  (select array[question_text, answered::text, (asked_person_at is not null)::text, page_kind]
   from public.unanswered_questions where request_id = :'unanswered'),
  array['¿Hay cajero automático?', 'false', 'true', 'home'],
  'and keeps its text, its page and «sin respuesta»');
select asked_person_at as first_mark from public.unanswered_questions where request_id = :'unanswered' \gset
set local role rikuy_ai;
select ai_api.record_person_request(:'ta', :'unanswered', '203.0.113.8', '¿Hay cajero automático?', 'es', 'home');
reset role;
select is((select asked_person_at from public.unanswered_questions where request_id = :'unanswered'),
  :'first_mark'::timestamptz, 'tapping twice keeps the first mark');

-- The race: taken to a person a moment before its unanswered record arrives.
select pg_temp.req(:'ta', '203.0.113.9') as race \gset
set local role rikuy_ai;
select ai_api.record_person_request(:'ta', :'race', '203.0.113.9', '¿Hay gasolina?', 'es', 'home');
select is(ai_api.record_unanswered_question(:'ta', :'race', '¿Hay gasolina?', 'es', 'home'), 'recorded',
  'its unanswered record still arrives');
reset role;
select is((select array[answered::text, (asked_person_at is not null)::text]
           from public.unanswered_questions where request_id = :'race'),
  array['false', 'true'], 'and makes it unanswered, with its mark');

select throws_ok(
  format($$insert into public.unanswered_questions (tenant_id, request_id, day, question_text, question_key, lang, page_kind, answered)
           values (%L, %L, current_date, 'hola', 'hola', 'es', 'home', true)$$, :'ta', pg_temp.req(:'ta', 'x')),
  '23514', null, 'an answered question is kept only when taken to a person');

-- ── Reading ─────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1';
insert into result select 'unanswered', public.tenant_unanswered_questions(:'ta', 30);
insert into result select 'person', public.tenant_person_requests(:'ta', 30);
set local request.jwt.claims to :'a2';
select lives_ok(format($$select public.tenant_person_requests(%L, 7)$$, :'ta'), 'an analyst reads them');
set local request.jwt.claims to :'a1_aal1';
select throws_ok(format($$select public.tenant_person_requests(%L, 7)$$, :'ta'), '42501', null,
  'an owner without the second factor does not (ADR-043)');
set local request.jwt.claims to :'b1';
select throws_ok(format($$select public.tenant_person_requests(%L, 7)$$, :'ta'), '42501', null,
  'nor the owner of another municipality');
set local request.jwt.claims to :'a1';
select throws_ok(format($$select public.tenant_person_requests(%L, 14)$$, :'ta'), '22023', null,
  'only 7, 30 or 90 days');
reset role;

select is(
  (select array_agg(g ->> 'key' order by g ->> 'key')
   from result, jsonb_array_elements(value -> 'groups') g where name = 'unanswered'),
  array['hay cajero automatico', 'hay gasolina'],
  'the unanswered questions do not include the ones the assistant answered');
select is(
  (select array[(value ->> 'total')::int, (value ->> 'askedPerson')::int,
                (select count(*)::int from jsonb_array_elements(value -> 'groups'))]
   from result where name = 'person'),
  array[4, 4, 4],
  'the questions taken to a person, answered or not, with how many');
select is(
  (select array[(g ->> 'answered')::int, (g ->> 'askedPerson')::int]
   from result, jsonb_array_elements(value -> 'groups') g
   where name = 'person' and g ->> 'key' = 'mi correo es correo el museo abre el domingo'),
  array[1, 1], 'each says how many the assistant had answered');

select * from finish();
rollback;
