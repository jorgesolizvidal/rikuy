-- A · Paso 5.1 (ADR-074): each answer of the visitor's assistant is kept with its channel,
-- kind, what it cited and what the visitor tapped in it afterwards. Only the AI role writes;
-- every member reads the totals; nothing of the visitor and no text is kept.
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

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;

set local role authenticated;
set local request.jwt.claims to :'a1';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
select * from public.save_content_draft(:'ta', pg_temp.id('museo'), format(:'place', 'Museo')::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('museo'), 2);
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
set local request.jwt.claims to :'b1';
insert into ids select 'museo-b', content_id from public.create_content_item(:'tb', 'destination', 'museo', 'Museo B');
reset role;

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

select plan(36);

-- ── Who writes and reads ────────────────────────────────────────────────────
select ok(not has_table_privilege('anon', 'public.assistant_turns', 'SELECT')
          and not has_table_privilege('authenticated', 'public.assistant_turns', 'SELECT')
          and not has_table_privilege('service_role', 'public.assistant_turns', 'SELECT')
          and not has_table_privilege('authenticated', 'public.assistant_turn_citations', 'SELECT')
          and not has_table_privilege('authenticated', 'public.assistant_turn_actions', 'SELECT')
          and not has_table_privilege('authenticated', 'public.assistant_turn_actions', 'INSERT'),
  'nobody reads or writes the turns directly');
select ok(not has_function_privilege('authenticated',
            'ai_api.record_assistant_turn(uuid, uuid, text, text, text, text[])', 'EXECUTE')
          and not has_function_privilege('service_role',
            'ai_api.record_assistant_turn(uuid, uuid, text, text, text, text[])', 'EXECUTE')
          and not has_function_privilege('anon',
            'ai_api.record_assistant_action(uuid, uuid, text, text, text)', 'EXECUTE'),
  'only the AI role records');
select ok(not has_function_privilege('anon', 'public.tenant_assistant_statistics(uuid, date, date)', 'EXECUTE'),
  'visitors cannot read the totals');
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public'
     and table_name in ('assistant_turns', 'assistant_turn_citations', 'assistant_turn_actions')
     and column_name ~ '(visitor|hash|ip|text|question|answer|email|agent)'),
  0, 'no column keeps anything of the visitor or any text');

-- ── Turns ───────────────────────────────────────────────────────────────────
select pg_temp.req(:'ta', '203.0.113.7') as portal \gset
select pg_temp.req(:'ta', '203.0.113.8') as qr \gset
select pg_temp.req(:'ta', '203.0.113.9') as embed \gset
select pg_temp.req(:'ta', '203.0.113.7', 'probe') as probe \gset
select pg_temp.req(:'ta', '203.0.113.7') as old \gset
update public.ai_requests set created_at = now() - interval '16 minutes' where id = :'old';
select pg_temp.req(:'tb', '203.0.113.7') as other \gset

set local role rikuy_ai;
select is(ai_api.record_assistant_turn(:'ta', :'portal', 'portal', 'answered', 'home',
    array['destination:museo', 'destination_tour:museo', 'service:nada', 'nada', 'event:x-y']),
  'recorded', 'an answer is kept with its channel');
select is(ai_api.record_assistant_turn(:'ta', :'portal', 'portal', 'answered', 'home'), 'ignored',
  'only once');
select is(ai_api.record_assistant_turn(:'ta', :'qr', 'qr', 'abstained', 'destination', array['destination:plaza']),
  'recorded', 'a QR one that knew nothing');
select is(ai_api.record_assistant_turn(:'ta', :'embed', 'embed', 'plan', 'other'), 'recorded',
  'a plan from the municipality''s website');
select is(ai_api.record_assistant_turn(:'tb', :'portal', 'portal', 'answered', 'home'), 'ignored',
  'never under another municipality');
select is(ai_api.record_assistant_turn(:'ta', :'probe', 'portal', 'answered', 'home'), 'ignored',
  'a request that is not the visitor''s assistant is not a turn');
select is(ai_api.record_assistant_turn(:'ta', :'old', 'portal', 'answered', 'home'), 'ignored',
  'nor one of more than 15 minutes ago');
select is(ai_api.record_assistant_turn(:'ta', gen_random_uuid(), 'portal', 'answered', 'home'), 'ignored',
  'nor an unknown one');
select throws_ok(format($$select ai_api.record_assistant_turn(%L, %L, 'email', 'answered', 'home')$$, :'ta', :'old'),
  '22023', null, 'an unknown channel is refused');
select throws_ok(format($$select ai_api.record_assistant_turn(%L, %L, 'portal', 'maybe', 'home')$$, :'ta', :'old'),
  '22023', null, 'and an unknown kind');
reset role;
select is(
  (select array[channel, kind, page_kind, day::text] from public.assistant_turns where request_id = :'portal'),
  array['portal', 'answered', 'home', (now() at time zone 'America/La_Paz')::date::text],
  'with its channel, kind, page and the municipality''s day');
select is(
  (select array_agg(content_id order by content_id) from public.assistant_turn_citations where request_id = :'portal'),
  array[pg_temp.id('museo')],
  'the museum and its tour count once; unknown keys are left out');
select ok(not exists (select 1 from public.assistant_turn_citations where content_id = pg_temp.id('museo-b')),
  'the same address in another municipality is never cited');
select is((select count(*)::int from public.assistant_turn_citations where request_id = :'qr'), 1,
  'a place is found by its address in this municipality');

-- ── Actions ─────────────────────────────────────────────────────────────────
set local role rikuy_ai;
select is(ai_api.record_assistant_action(:'ta', :'portal', '203.0.113.7', 'place', 'destination:museo'), 'recorded',
  'the visitor opened the museum from the answer');
select is(ai_api.record_assistant_action(:'ta', :'portal', '203.0.113.7', 'place', 'destination:museo'), 'recorded',
  'twice is still one');
select is(ai_api.record_assistant_action(:'ta', :'portal', '203.0.113.7', 'tour', 'destination_tour:museo'), 'recorded',
  'and its tour');
select is(ai_api.record_assistant_action(:'ta', :'portal', '203.0.113.7', 'map'), 'recorded', 'and the map');
select is(ai_api.record_assistant_action(:'ta', :'portal', '198.51.100.1', 'section'), 'ignored',
  'another visitor cannot add to someone else''s answer');
select is(ai_api.record_assistant_action(:'ta', :'portal', null, 'section'), 'ignored',
  'nor someone without a visitor key');
select is(ai_api.record_assistant_action(:'ta', :'other', '203.0.113.7', 'section'), 'ignored',
  'nor an answer that was never recorded');
select is(ai_api.record_assistant_action(:'ta', :'portal', '203.0.113.7', 'place', 'destination:nada'), 'ignored',
  'a place that does not exist is not kept');
select throws_ok(format($$select ai_api.record_assistant_action(%L, %L, '203.0.113.7', 'share')$$, :'ta', :'portal'),
  '22023', null, 'an unknown action is refused');
reset role;
select is((select count(*)::int from public.assistant_turn_actions where request_id = :'portal'), 3,
  'three actions under that answer');
set local role rikuy_ai;
select is(ai_api.record_assistant_action(:'ta', :'qr', '203.0.113.8', 'section'), 'recorded',
  'a portal section from the QR answer');
reset role;

-- A question taken to a person counts for its channel (ADR-073).
set local role rikuy_ai;
select ai_api.record_person_request(:'ta', :'qr', '203.0.113.8', '¿Hay cajero?', 'es', 'destination', 'plaza');
reset role;

-- ── Reading ─────────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1';
insert into result select 'stats',
  public.tenant_assistant_statistics(:'ta', (now() at time zone 'America/La_Paz')::date - 6,
                                      (now() at time zone 'America/La_Paz')::date);
set local request.jwt.claims to :'a2';
select lives_ok(format($$select public.tenant_assistant_statistics(%L, current_date - 1, current_date)$$, :'ta'),
  'an analyst reads the totals');
set local request.jwt.claims to :'a1_aal1';
select throws_ok(format($$select public.tenant_assistant_statistics(%L, current_date - 1, current_date)$$, :'ta'),
  '42501', null, 'an owner without the second factor does not (ADR-043)');
set local request.jwt.claims to :'b1';
select throws_ok(format($$select public.tenant_assistant_statistics(%L, current_date - 1, current_date)$$, :'ta'),
  '42501', null, 'nor the owner of another municipality');
set local request.jwt.claims to :'a1';
select throws_ok(format($$select public.tenant_assistant_statistics(%L, current_date, current_date - 1)$$, :'ta'),
  '22023', null, 'an inverted period is refused');
reset role;

select is(
  (select jsonb_agg(jsonb_build_array(c ->> 'channel', c ->> 'conversations', c ->> 'answered',
                                      c ->> 'abstained', c ->> 'plans', c ->> 'askedPerson')
                    order by c ->> 'channel')
   from result, jsonb_array_elements(value -> 'channels') c where name = 'stats'),
  '[["embed","1","0","0","1","0"],["portal","1","1","0","0","0"],["qr","1","0","1","0","1"]]'::jsonb,
  'by channel: conversations, answered, abstained, plans and taken to a person');
select is(
  (select jsonb_agg(jsonb_build_array(t ->> 'slug', t ->> 'times', t ->> 'published') order by t ->> 'slug')
   from result, jsonb_array_elements(value -> 'topics') t where name = 'stats'),
  '[["museo","1","true"],["plaza","1","false"]]'::jsonb,
  'the topics are what the answers cited');

-- Deleting a gateway request (after 90 days) takes its turn with it.
delete from public.ai_requests where id = :'portal';
select ok(not exists (select 1 from public.assistant_turns where request_id = :'portal')
          and not exists (select 1 from public.assistant_turn_actions where request_id = :'portal'),
  'a turn goes with its request');

select * from finish();
rollback;
