-- A · Paso 1.2 (ADR-069): local services. The module, what a draft accepts, who prepares and
-- who publishes, what publishing asks for, what visitors read, «Retirar», what the indexer
-- reads, and that the other kinds of content stay as they were.
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

-- A service as the editor writes it; each test changes one thing.
create function pg_temp.service(p_changes jsonb default '{}')
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'title', 'Restaurante La Casona',
    'summary', 'Almuerzos y comida típica.',
    'category', 'food',
    'hours', '{"mode":"weekly","days":[[["12:00","15:00"]],[],[],[],[],[],[]],"note":""}'::jsonb,
    'phone', '4 4441234',
    'whatsapp', '+591 70000000',
    'address', 'Calle Bolívar 12',
    'location', '{"lat":-17.4,"lng":-66.1}'::jsonb
  ) || p_changes;
$$;

select plan(39);

-- ── The module ──────────────────────────────────────────────────────────────
select ok(exists (select 1 from public.platform_modules where key = 'services'), 'services are a module');
select ok(private.has_module(:'ta', 'services'), 'a new municipality has it');
select ok(has_function_privilege('anon', 'public.portal_services(uuid)', 'EXECUTE'), 'visitors read the services');

-- ── Drafts ──────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table food as select * from public.create_content_item(:'ta', 'service', 'la-casona', 'Restaurante La Casona');
select ok((select content_id from food) is not null, 'an editor creates a service');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from food), pg_temp.service()),
  'and saves its category, hours, phone, WhatsApp, address and place'
);
select is(
  public.content_revision_document(:'ta', (select draft_revision_id from public.content_items where id = (select content_id from food))),
  pg_temp.service(), 'the editor reads it back as written'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food),
    pg_temp.service('{"category":"bar"}')),
  '23514', null, 'a category outside the platform''s list is refused'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food),
    pg_temp.service('{"whatsapp":"70000000"}')),
  '23514', null, 'a WhatsApp number needs its country code'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food),
    pg_temp.service('{"phone":"llamar al 444"}')),
  '23514', null, 'a phone is a number'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food),
    pg_temp.service('{"body":[]}')),
  '23514', null, 'a service has no other keys'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food),
    pg_temp.service('{"hours":{"mode":"weekly","days":[[["15:00","12:00"]],[],[],[],[],[],[]],"note":""}}')),
  '23514', null, 'opening hours that close before they open are refused'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food),
    pg_temp.service('{"location":{"lat":91,"lng":0}}')),
  '23514', null, 'a place off the map is refused'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food),
    pg_temp.service(jsonb_build_object('address', E'Calle 1\nCalle 2'))),
  '23514', null, 'the address is one line'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 2)', :'ta', (select content_id from food)),
  '42501', null, 'an editor cannot publish a service'
);
select throws_ok(
  format('select public.retire_content(%L, %L)', :'ta', (select content_id from food)),
  '42501', null, 'nor retire it'
);
set local request.jwt.claims to :'a4c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food), pg_temp.service()),
  '42501', null, 'an analyst cannot change it'
);
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from food), pg_temp.service()),
  '42501', null, 'nor the owner of another municipality'
);

-- ── Publishing ──────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a1c';
select is((select revision_no from public.publish_content(:'ta', (select content_id from food), 2)), 1,
  'the owner publishes it');
create temp table nowhere as select * from public.create_content_item(:'ta', 'service', 'taxi', 'Radio taxi');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from nowhere),
    pg_temp.service('{"title":"Radio taxi","category":"transport","address":"","location":null,"hours":null}')),
  'a service may be saved without an address or a place'
);
select throws_ok(
  format('select * from public.publish_content(%L, %L, 2)', :'ta', (select content_id from nowhere)),
  '23514', null, 'but not published: visitors need to find it'
);
create temp table cash as select * from public.create_content_item(:'ta', 'service', 'cajero', 'Cajero automático');
select * from public.save_content_draft(:'ta', (select content_id from cash), pg_temp.service(
  '{"title":"Cajero automático","summary":"","category":"cash","hours":{"mode":"always","note":""},"phone":null,"whatsapp":null,"location":null}'), 1);
select is((select revision_no from public.publish_content(:'ta', (select content_id from cash), 2)), 1,
  'an address alone is enough to find it');
reset role;
grant select on food, nowhere, cash to authenticated, anon, rikuy_worker;

-- ── What visitors read ──────────────────────────────────────────────────────
set local role anon;
select results_eq(
  format('select slug, category, phone, whatsapp, address, latitude, hours ->> ''mode'' from public.portal_services(%L)', :'ta'),
  $$values ('la-casona', 'food', '4 4441234', '+591 70000000', 'Calle Bolívar 12', -17.4::double precision, 'weekly'),
           ('cajero', 'cash', null, null, 'Calle Bolívar 12', null::double precision, 'always')$$,
  'the published services, food before cash, never the draft'
);
select is((select count(*)::int from public.portal_services(:'tb')), 0, 'another municipality reads none of them');
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::int from public.portal_services(:'ta')), 0, 'nor anyone while it is suspended');
reset role;
update public.tenants set status = 'active' where id = :'ta';

-- ── «Retirar» (it closed) ───────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(format('select public.retire_content(%L, %L)', :'ta', (select content_id from cash)),
  'the owner retires a service that closed');
set local role anon;
select is((select array_agg(slug) from public.portal_services(:'ta')), array['la-casona'], 'and visitors stop seeing it');
set local role authenticated;
set local request.jwt.claims to :'a1c';
select lives_ok(
  format('select * from public.restore_content_revision(%L, %L, %L)', :'ta', (select content_id from cash),
    (select revision_id from public.content_revisions where content_id = (select content_id from cash) and state = 'sealed')),
  '«Volver a esta versión» publishes it again'
);
reset role;
select is(
  (select diff ->> 'kind' from public.audit_events where action = 'content.retired' and entity_id = (select content_id from cash)),
  'service', 'retiring it is audited'
);

-- ── What the assistant's indexer reads ──────────────────────────────────────
select ok(exists (
  select 1 from public.background_jobs j
  join public.content_items i on i.id = (select content_id from food)
  where j.kind = 'knowledge.index' and j.subject_id = i.published_revision_id
), 'publishing a service queues its indexing');
-- Only this service's indexing is claimed.
update public.background_jobs set available_at = now() + interval '1 day'
where kind = 'knowledge.index' and status = 'pending'
  and subject_id <> (select published_revision_id from public.content_items where id = (select content_id from food));
set local role rikuy_worker;
create temp table claim as select * from worker_api.claim_jobs('runner-s', 10, array['knowledge.index']);
reset role;
create temp table food_job as
select c.job_id, c.fencing_token from claim c
join public.background_jobs j on j.id = c.job_id
where j.subject_id = (select published_revision_id from public.content_items where id = (select content_id from food));
grant select on food_job to rikuy_worker;
set local role rikuy_worker;
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) -> 'service' from food_job),
  '{"category":"food","phone":"4 4441234","whatsapp":"+591 70000000","address":"Calle Bolívar 12"}'::jsonb,
  'it reads the category, the phone, the WhatsApp and the address'
);
select is(
  (select worker_api.knowledge_source(job_id, fencing_token) #>> '{hours,mode}' from food_job),
  'weekly', 'and the opening hours'
);
reset role;

-- ── The module off, and the other kinds as they were ────────────────────────
delete from public.tenant_modules where tenant_id = :'tb' and module = 'services';
set local role authenticated;
set local request.jwt.claims to :'b1c';
select throws_ok(
  format('select * from public.create_content_item(%L, %L, %L, %L)', :'tb', 'service', 'cajero', 'Cajero'),
  'PT403', null, 'without the module, no service can be created'
);
set local request.jwt.claims to :'a1c';
create temp table plaza as select * from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from plaza),
    '{"title":"Plaza","summary":"La plaza.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'),
  'destinations still save as before'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from plaza),
    '{"title":"Plaza","summary":"La plaza.","body":[],"location":null,"cover":null,"gallery":[],"phone":"4 444"}'),
  '23514', null, 'and without the service''s fields'
);
select throws_ok(
  format('select * from public.create_tour(%L, %L)', :'ta', (select content_id from food)),
  '23514', null, 'a service has no tour'
);
create temp table cut as select * from public.create_content_item(:'ta', 'notice', 'corte', 'Corte');
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from cut),
    jsonb_build_object('title', 'Corte', 'summary', 'Cerrado.', 'body', '[]'::jsonb,
      'validity', '{"from":null,"until":null}'::jsonb, 'placeId', (select content_id from food))),
  '23514', null, 'nor is it a notice''s place'
);
reset role;
select is(
  (select r.service_category from public.content_revisions r where r.content_id = (select content_id from plaza)),
  null, 'a destination never gets a category of services'
);
select throws_ok(
  format('update public.content_revisions set service_category = %L where content_id = %L', 'bar', (select content_id from nowhere)),
  '23514', null, 'the table itself only takes the platform''s categories'
);
select ok(not has_function_privilege('anon', 'private.is_valid_service_draft(jsonb)', 'EXECUTE'),
  'visitors cannot call the validation');

select * from finish();
rollback;
