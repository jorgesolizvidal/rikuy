-- A · Paso 6 (ADR-075): the municipality's assistant on WhatsApp. Only the platform operator
-- (second factor) registers a municipality's number; any member sees it; a number belongs to
-- one municipality. The webhook (role rikuy_ai) resolves the municipality from the number,
-- takes each message once, keys the sender by a hash (never the number) and keeps the last six
-- messages of a conversation for 24 hours, masked.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set op  '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a4c '{"sub":"00000000-0000-4000-8000-0000000000a4","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'operador@example.test'),
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a4', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.platform_operators (user_id, status) values
  ('00000000-0000-4000-8000-0000000000f1', 'active');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at) values
  (:'ta', 'a.whatsapp.test', 'platform', 'active', now()),
  (:'tb', 'b.whatsapp.test', 'platform', 'active', now());
update public.tenants t set canonical_domain_id = d.id
from public.tenant_domains d where d.tenant_id = t.id and t.id in (:'ta', :'tb');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a4', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active' where id in (:'ta', :'tb');
set constraints all immediate;

-- The AI role runs the assertions of its own calls.
grant usage on schema extensions to rikuy_ai;
do $$ begin execute format('grant temporary on database %I to rikuy_ai', current_database()); end $$;

select plan(41);

-- ── Nobody touches the tables ───────────────────────────────────────────────
select ok(not has_table_privilege('authenticated', 'public.whatsapp_numbers', 'select')
       and not has_table_privilege('anon', 'public.whatsapp_numbers', 'select')
       and not has_table_privilege('authenticated', 'public.whatsapp_messages', 'select')
       and not has_table_privilege('anon', 'public.whatsapp_messages', 'select')
       and not has_table_privilege('authenticated', 'public.whatsapp_inbound', 'select')
       and not has_table_privilege('rikuy_ai', 'public.whatsapp_messages', 'select'),
  'no role reads the numbers, the conversations or the messages taken');
select is(
  (select count(*)::int from information_schema.columns
   where table_schema = 'public' and table_name in ('whatsapp_messages', 'whatsapp_inbound')
     and column_name ~ '(wa_id|phone|from|number)'),
  0, 'no column keeps the sender''s number');

-- ── Only the operator registers a number ────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(format('select public.platform_add_whatsapp_number(%L, %L, null)', :'ta', '1234567890'),
  '42501', null, 'the owner of the municipality cannot register a number');
set local request.jwt.claims to :'op1';
select throws_ok(format('select public.platform_add_whatsapp_number(%L, %L, null)', :'ta', '1234567890'),
  '42501', null, 'nor an operator without the second factor');

set local request.jwt.claims to :'op';
select is(jsonb_array_length(public.platform_add_whatsapp_number(:'ta', '1234567890', ' +591 67680091 ')), 1,
  'the operator registers a number');
select is(public.platform_whatsapp_numbers(:'ta') -> 0 ->> 'displayPhone', '+591 67680091',
  'with the number visitors see, trimmed');
reset role;
select is(
  (select count(*)::int from public.audit_events
   where tenant_id = :'ta' and action = 'platform.whatsapp_number_added'),
  1, 'audited');
set local role authenticated;
set local request.jwt.claims to :'op';
select throws_ok(format('select public.platform_add_whatsapp_number(%L, %L, null)', :'ta', '12ab'),
  '23514', null, 'Meta''s id is digits only');
select throws_ok(format('select public.platform_add_whatsapp_number(%L, %L, %L)', :'ta', '1234567891', '67680091'),
  '23514', null, 'a number for visitors needs + and its country code');
select throws_ok(format('select public.platform_add_whatsapp_number(%L, %L, null)', :'tb', '1234567890'),
  'PT409', null, 'a number belongs to one municipality');
select throws_ok(format('select public.platform_add_whatsapp_number(%L, %L, null)',
    'cccccccc-0000-4000-8000-000000000001', '1234567892'),
  'PT404', null, 'an unknown municipality');
select is(jsonb_array_length(public.platform_add_whatsapp_number(:'ta', '1234567890', null)), 1,
  'registering it again changes its visible number, not how many there are');
select is(public.platform_whatsapp_numbers(:'ta') -> 0 ->> 'displayPhone', null,
  'and can leave it empty');
select lives_ok(format('select public.platform_add_whatsapp_number(%L, %L, null)', :'ta', '1234567891'),
  'a second number');
select lives_ok(format('select public.platform_add_whatsapp_number(%L, %L, null)', :'ta', '1234567892'),
  'a third number');
select throws_ok(format('select public.platform_add_whatsapp_number(%L, %L, null)', :'ta', '1234567893'),
  'PT409', null, 'up to three numbers per municipality');
select is(jsonb_array_length(public.platform_remove_whatsapp_number(:'ta', '1234567892')), 2,
  'the operator removes one');
reset role;
select is(
  (select count(*)::int from public.audit_events
   where tenant_id = :'ta' and action = 'platform.whatsapp_number_removed'),
  1, 'audited');
set local role authenticated;
set local request.jwt.claims to :'op';
select lives_ok(format('select public.platform_remove_whatsapp_number(%L, %L)', :'ta', '1234567891'),
  'removing another');

-- ── Members see them ────────────────────────────────────────────────────────
set local request.jwt.claims to :'a4c';
select is(public.tenant_whatsapp_numbers(:'ta') -> 0 ->> 'phoneNumberId', '1234567890',
  'an analyst of the municipality sees its number');
select throws_ok(format('select public.platform_whatsapp_numbers(%L)', :'ta'),
  '42501', null, 'but not through the operator''s function');
set local request.jwt.claims to :'b1c';
select throws_ok(format('select public.tenant_whatsapp_numbers(%L)', :'ta'),
  '42501', null, 'the owner of another municipality does not');
set local role anon;
select throws_ok(format('select public.tenant_whatsapp_numbers(%L)', :'ta'),
  '42501', null, 'nor a visitor');
select throws_ok($$select ai_api.whatsapp_begin('1234567890', 'wamid.x', '59167680091')$$,
  '42501', null, 'a visitor cannot pretend to be the webhook');
reset role;

-- ── The webhook ─────────────────────────────────────────────────────────────
set local role rikuy_ai;
select is(ai_api.whatsapp_begin('9999999999', 'wamid.0', '59167680091') ->> 'status', 'unknown_number',
  'a number no municipality has');
select throws_ok($$select ai_api.whatsapp_begin('1234567890', 'wamid.x', '+591 676')$$,
  '22023', null, 'a sender that is not a WhatsApp id');
select ai_api.whatsapp_begin('1234567890', 'wamid.1', '59167680091') as first \gset
select is(:'first'::jsonb ->> 'status', 'new', 'a message to the number is new');
select is((:'first'::jsonb ->> 'tenantId')::uuid, :'ta'::uuid, 'for the municipality the number belongs to');
select is(:'first'::jsonb ->> 'host', 'a.whatsapp.test', 'with its portal''s host');
select ok((:'first'::jsonb ->> 'contactKey') ~ '^[0-9a-f]{64}$'
          and position('67680091' in :'first') = 0,
  'the sender is a hash, never the number');
select is(ai_api.whatsapp_begin('1234567890', 'wamid.1', '59167680091') ->> 'status', 'duplicate',
  'each message is taken once');

select lives_ok(format(
  $$select ai_api.whatsapp_remember(%L, %L, 'Mi correo es ana@example.test, ¿hay cajero?', 'Sí, en la plaza.')$$,
  :'ta', :'first'::jsonb ->> 'contactKey'), 'the question and its answer are kept');
select ai_api.whatsapp_begin('1234567890', 'wamid.2', '59167680091') as second \gset
select is(:'second'::jsonb ->> 'contactKey', :'first'::jsonb ->> 'contactKey',
  'the same sender keeps the same key');
select is(:'second'::jsonb -> 'history',
  '[{"role":"user","text":"Mi correo es [correo], ¿hay cajero?"},{"role":"assistant","text":"Sí, en la plaza."}]'::jsonb,
  'the next message brings the conversation, masked');
select throws_ok(format($$select ai_api.whatsapp_remember(%L, 'not-a-key', 'x', 'y')$$, :'ta'),
  '22023', null, 'only a contact key');
do $$
begin
  for i in 1..4 loop
    perform ai_api.whatsapp_remember(
      'aaaaaaaa-0000-4000-8000-000000000001',
      (select ai_api.whatsapp_begin('1234567890', 'wamid.loop' || i, '59167680091') ->> 'contactKey'),
      'Pregunta ' || i, 'Respuesta ' || i);
  end loop;
end $$;
select is(jsonb_array_length(ai_api.whatsapp_begin('1234567890', 'wamid.3', '59167680091') -> 'history'), 6,
  'the conversation keeps its last six messages');
reset role;

update public.whatsapp_messages set created_at = now() - interval '25 hours'
where tenant_id = :'ta' and body like 'Pregunta 4';
set local role rikuy_ai;
select is(jsonb_array_length(ai_api.whatsapp_begin('1234567890', 'wamid.4', '59167680091') -> 'history'), 5,
  'nothing older than 24 hours');
select isnt(
  ai_api.whatsapp_begin('1234567890', 'wamid.5', '59167680092') ->> 'contactKey',
  :'first'::jsonb ->> 'contactKey', 'another sender, another key');
reset role;

-- Not online, past the day's cap.
update public.tenants set status = 'suspended' where id = :'ta';
set local role rikuy_ai;
select is(ai_api.whatsapp_begin('1234567890', 'wamid.6', '59167680091') ->> 'status', 'unavailable',
  'a municipality that is not online answers nothing');
reset role;
update public.tenants set status = 'active' where id = :'ta';
insert into public.whatsapp_inbound (message_id, tenant_id)
select 'wamid.cap' || g, :'ta' from generate_series(1, 5000) g;
set local role rikuy_ai;
select is(ai_api.whatsapp_begin('1234567890', 'wamid.7', '59167680091') ->> 'status', 'capped',
  'up to 5.000 messages a day per municipality');
reset role;

-- ── Forgotten ───────────────────────────────────────────────────────────────
update public.whatsapp_inbound set received_at = now() - interval '3 days' where tenant_id = :'ta';
update public.whatsapp_messages set created_at = now() - interval '25 hours' where tenant_id = :'ta';
select private.forget_whatsapp();
select ok(
  not exists (select 1 from public.whatsapp_messages where tenant_id = :'ta')
  and not exists (select 1 from public.whatsapp_inbound where tenant_id = :'ta'),
  'conversations after 24 hours and messages taken after two days are forgotten');

select * from finish();
rollback;
