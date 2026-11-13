-- The tourist passport in «Estadísticas» (C2 · Paso 4, ADR-059): a stamp is counted once per
-- phone, place and day, «located» once more when the phone says it was there; the totals keep
-- nothing that identifies the phone and nobody reads them directly; any member reads them by
-- period (owners and admins with their second factor), another municipality and visitors do
-- not; completed circuits and redeemed prizes come from the vouchers; the Copilot's facts may
-- come from the passport and lead to a circuit of this municipality only.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set ownera1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set analysta '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal1"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set p1 'AbCdEfGhIjKlMnOpQrSt_1'
\set p2 'AbCdEfGhIjKlMnOpQrSt_2'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'editor', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'analyst', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

create temp table ids (name text primary key, id uuid);
create temp table scratch (v text);
grant select, insert on ids, scratch to authenticated, anon;

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'borrador', content_id from public.create_content_item(:'ta', 'destination', 'borrador', 'Borrador');
reset role;
insert into public.content_revisions (id, tenant_id, content_id, revision_no, state, title, summary, latitude, longitude, sealed_at)
select gen_random_uuid(), i.tenant_id, i.id, 2, 'sealed', initcap(i.slug), 'Texto.', -17.5, -65.9, now()
from public.content_items i where i.id in (select id from ids where name in ('plaza', 'museo'));
update public.content_items c set published_revision_id = r.id, published_at = now()
from public.content_revisions r where r.content_id = c.id and r.state = 'sealed'
  and c.id in (select id from ids where name in ('plaza', 'museo'));

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'ruta', public.create_passport_circuit(:'ta', 'ruta', 'Ruta');
insert into scratch select public.save_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 1, 'Ruta', '',
  'Una postal.', array[(select id from ids where name = 'plaza'), (select id from ids where name = 'museo'),
                       (select id from ids where name = 'borrador')]);
insert into scratch select public.publish_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 2);
reset role;

create temp view code_of as
select i.name, k.code from public.passport_stamp_codes k join ids i on i.id = k.content_id;
grant select on code_of to anon, authenticated;

create temp table stamps (passport text, place text, s jsonb);
grant select, insert on stamps to anon, authenticated;
create temp view counted as
select (select name from ids where id = d.content_id) as place, d.stamps, d.located
from public.passport_daily_stamps d where d.tenant_id = :'ta';

select plan(32);

-- ── Counting stamps ───────────────────────────────────────────────────────
set local role anon;
insert into stamps select :'p1', 'plaza', public.portal_collect_stamp(:'ta', (select code from code_of where name = 'plaza'), :'p1', true);
reset role;
select is((select stamps || '/' || located from counted where place = 'plaza'), '1/1',
  'a stamp from the place counts once, and once as a visit verified on the spot');
select ok(private.passport_stamp_valid(:'ta', (select id from ids where name = 'plaza'), :'p1',
    (select (s->>'at')::bigint from stamps where passport = :'p1' and place = 'plaza'), true,
    (select s->>'signature' from stamps where passport = :'p1' and place = 'plaza')),
  'the stamp is still signed as before');

set local role anon;
insert into stamps select :'p1', 'plaza', public.portal_collect_stamp(:'ta', (select code from code_of where name = 'plaza'), :'p1', true);
insert into stamps select :'p2', 'plaza', public.portal_collect_stamp(:'ta', (select code from code_of where name = 'plaza'), :'p2', false);
reset role;
select is((select stamps || '/' || located from counted where place = 'plaza'), '2/1',
  'the same phone again the same day does not count; another phone without location does, not as verified');

set local role anon;
insert into stamps select :'p2', 'plaza', public.portal_collect_stamp(:'ta', (select code from code_of where name = 'plaza'), :'p2', true);
insert into stamps select :'p1', 'museo', public.portal_collect_stamp(:'ta', (select code from code_of where name = 'museo'), :'p1', false);
reset role;
select is((select stamps || '/' || located from counted where place = 'plaza'), '2/2',
  'stamping again from the place the same day adds the verified visit, not another stamp');
select is((select stamps || '/' || located from counted where place = 'museo'), '1/0', 'each place counts on its own');

set local role anon;
select is(public.portal_collect_stamp(:'ta', 'NoEsUnCodigoValido_123', :'p1', true), null, 'an unknown code stamps nothing');
select is(public.portal_collect_stamp(:'tb', (select code from code_of where name = 'plaza'), :'p1', true), null,
  'nor a code of another municipality');
reset role;
select is((select sum(stamps)::int from public.passport_daily_stamps where tenant_id in (:'ta', :'tb')), 3,
  'and counts nothing');
select is((select day from public.passport_daily_stamps where tenant_id = :'ta' limit 1), (now() at time zone 'America/La_Paz')::date,
  'the day is the municipality''s');
select ok((select bool_and(m.hash ~ '^[0-9a-f]{64}$' and m.hash not like '%' || :'p1' || '%')
           from private.visit_marks m where m.scope in ('stamp', 'stamp_located')),
  'who was counted is kept only as a daily fingerprint');
select is(
  (select array_agg(column_name::text order by column_name) from information_schema.columns
   where table_schema = 'public' and table_name = 'passport_daily_stamps'),
  array['content_id', 'day', 'located', 'stamps', 'tenant_id'], 'the totals keep nothing about a phone');

-- The cap: past it, stamps are still signed but not counted.
update public.passport_daily_stamps set stamps = 2000, located = 0
where tenant_id = :'ta' and content_id = (select id from ids where name = 'museo');
set local role anon;
select ok(public.portal_collect_stamp(:'ta', (select code from code_of where name = 'museo'), :'p2', true) ->> 'signature' is not null,
  'past the daily cap the phone still gets its stamp');
reset role;
select is((select stamps || '/' || located from counted where place = 'museo'), '2000/0', 'but it is not counted');
update public.passport_daily_stamps set stamps = 1, located = 0
where tenant_id = :'ta' and content_id = (select id from ids where name = 'museo');

select throws_ok('set local role anon; select * from public.passport_daily_stamps', '42501', null,
  'visitors do not read the totals');
reset role;
select throws_ok('set local role authenticated; select * from public.passport_daily_stamps', '42501', null,
  'nor members, directly');
reset role;
select throws_ok(format('set local role anon; select private.record_passport_stamp(%L, %L, %L, true)',
  :'ta', (select id from ids where name = 'plaza'), :'p1'), '42501', null, 'nobody counts a stamp by hand');
reset role;

-- ── Completed circuits and prizes ─────────────────────────────────────────
set local role anon;
create temp table v1 as
select public.portal_request_voucher(:'ta', 'ruta', :'p1', (
  select jsonb_agg(jsonb_build_object('placeId', s->'id', 'at', s->'at', 'located', s->'located', 'signature', s->'signature'))
  from (select distinct on (place) s from stamps where passport = :'p1' order by place) x)) as v;
reset role;
update public.passport_circuits set redeem_pin_hash = extensions.crypt('2468', extensions.gen_salt('bf', 8)),
  redeem_pin_set_at = now() where id = (select id from ids where name = 'ruta');
set local role anon;
select is(public.portal_redeem_voucher(:'ta', (select v->>'code' from v1), '2468', true)->>'status', 'redeemed',
  'the phone completes the circuit and the shop hands over the prize');
reset role;

-- ── Reading them ──────────────────────────────────────────────────────────
create temp table stats (who text, v jsonb);
grant insert, select on stats to authenticated;
\set today '(now() at time zone \'America/La_Paz\')::date'
set local role authenticated;
set local request.jwt.claims to :'analysta';
insert into stats select 'analyst', public.tenant_passport_statistics(:'ta', :today - 6, :today, false);
set local request.jwt.claims to :'editora';
insert into stats select 'editor', public.tenant_passport_statistics(:'ta', :today - 6, :today, true);
set local request.jwt.claims to :'ownera';
insert into stats select 'owner', public.tenant_passport_statistics(:'ta', :today - 6, :today, false);
select throws_ok(format('select public.tenant_passport_statistics(%L, %L, %L, false)', :'ta', current_date, current_date - 1),
  '22023', null, 'a period that ends before it starts is refused');
select throws_ok(format('select public.tenant_passport_statistics(%L, %L, %L, false)', :'ta', current_date - 401, current_date),
  '22023', null, 'and one of more than 400 days');
set local request.jwt.claims to :'ownera1';
select throws_ok(format('select public.tenant_passport_statistics(%L, %L, %L, false)', :'ta', current_date, current_date),
  '42501', null, 'an owner without the second factor does not read them');
set local request.jwt.claims to :'ownerb';
select throws_ok(format('select public.tenant_passport_statistics(%L, %L, %L, false)', :'ta', current_date, current_date),
  '42501', null, 'nor another municipality''s owner');
reset role;
select throws_ok(format('set local role anon; select public.tenant_passport_statistics(%L, %L, %L, false)', :'ta', current_date, current_date),
  '42501', null, 'nor visitors');
reset role;

select is((select v from stats where who = 'analyst'), (select v from stats where who = 'owner'),
  'an analyst reads what the owner reads');
select is(
  (select jsonb_object_agg(p->>'slug', (p->>'stamps') || '/' || (p->>'located'))
   from stats, jsonb_array_elements(v->'places') p where who = 'owner'),
  '{"plaza": "2/2", "museo": "1/0"}'::jsonb,
  'stamps and verified visits per place; the never-published stop is left out');
select is(
  (select jsonb_agg(c - 'circuitId') from stats, jsonb_array_elements(v->'circuits') c where who = 'owner'),
  '[{"day": null, "name": "Ruta", "slug": "ruta", "published": true, "completed": 1, "redeemed": 1}]'::jsonb,
  'one phone completed the circuit and its prize was redeemed');
select is((select v->>'since' from stats where who = 'owner'), (now() at time zone 'America/La_Paz')::date::text,
  'it says since when stamps are counted');
select is(
  (select count(*)::int from stats, jsonb_array_elements(v->'places') p
   where who = 'editor' and p->>'day' = (now() at time zone 'America/La_Paz')::date::text),
  2, 'per day when asked');

-- A published stop nobody stamped appears with zeros; another municipality's stamps never.
reset role;
delete from public.passport_daily_stamps where content_id = (select id from ids where name = 'museo');
select is(
  (select p->>'stamps' from jsonb_array_elements(
     private.passport_statistics(:'ta', (now() at time zone 'America/La_Paz')::date, (now() at time zone 'America/La_Paz')::date, false)->'places') p
   where p->>'slug' = 'museo'),
  '0', 'a stop nobody stamped appears with zeros');
select is(
  jsonb_array_length(private.passport_statistics(:'tb', current_date - 30, current_date, false)->'places'),
  0, 'another municipality sees none of it');

-- ── The Copilot's facts ───────────────────────────────────────────────────
select lives_ok(format('select private.assert_valid_recommendations(%L, %L, %L)', :'ta',
  jsonb_build_array(jsonb_build_object('id', 'H1', 'source', 'passport', 'text', 'Circuito «Ruta»: 1 persona lo completó.',
    'target', jsonb_build_object('type', 'circuit', 'circuitId', (select id from ids where name = 'ruta')))),
  '[{"title":"Coloca los QR de sello","why":"Solo 1 persona lo completó.","facts":["H1"]}]'),
  'a recommendation may rest on a passport fact that leads to its circuit');
select throws_ok(format('select private.assert_valid_recommendations(%L, %L, %L)', :'tb',
  jsonb_build_array(jsonb_build_object('id', 'H1', 'source', 'passport', 'text', 'Circuito «Ruta»: 1 persona lo completó.',
    'target', jsonb_build_object('type', 'circuit', 'circuitId', (select id from ids where name = 'ruta')))),
  '[{"title":"Coloca los QR de sello","why":"Solo 1 persona lo completó.","facts":["H1"]}]'),
  '23514', null, 'never to another municipality''s circuit');
select throws_ok(format('select private.assert_valid_recommendations(%L, %L, %L)', :'ta',
  jsonb_build_array(jsonb_build_object('id', 'H1', 'source', 'passport', 'text', 'Circuito «Ruta».',
    'target', jsonb_build_object('type', 'circuit', 'circuitId', 'no-es-un-id'))),
  '[{"title":"Coloca los QR de sello","why":"Por el circuito.","facts":["H1"]}]'),
  '23514', null, 'nor to something that is not an id');

select * from finish();
rollback;
