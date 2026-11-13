-- The circuits of the tourist passport (C2 · Paso 1, ADR-056): any member reads them; editors
-- build drafts; owners and admins publish, withdraw and change what is published; stops are
-- destinations of the same municipality; the portal shows only published circuits with the
-- stops whose destination is published now, of online municipalities. Nobody touches the
-- tables directly.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set ownera1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set analysta '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal2"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'

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
grant select, insert, update on ids to authenticated, anon;

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'iglesia', content_id from public.create_content_item(:'ta', 'destination', 'iglesia', 'Iglesia');
insert into ids select 'feria', content_id from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
set local request.jwt.claims to :'ownerb';
insert into ids select 'laguna', content_id from public.create_content_item(:'tb', 'destination', 'laguna', 'Laguna');
reset role;
-- The plaza and the museum published (sealed revision 2 as the published pointer); the church
-- only a draft.
insert into public.content_revisions (id, tenant_id, content_id, revision_no, state, title, summary, sealed_at)
select gen_random_uuid(), :'ta', i.id, 2, 'sealed', initcap(i.name), 'Texto.', now()
from ids i where i.name in ('plaza', 'museo');
update public.content_items c set published_revision_id = r.id, published_at = now()
from public.content_revisions r
where r.content_id = c.id and r.state = 'sealed' and c.id in (select id from ids where name in ('plaza', 'museo'));

select plan(41);

-- ── Creating and saving ────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'editora';
insert into ids select 'ruta', public.create_passport_circuit(:'ta', 'ruta-historica', 'Ruta histórica');
select ok((select id from ids where name = 'ruta') is not null, 'an editor creates a draft circuit');
select throws_ok(format('select public.create_passport_circuit(%L, %L, %L)', :'ta', 'ruta-historica', 'Otra'),
  '23505', null, 'its address is unique in the municipality');
select throws_ok(format('select public.create_passport_circuit(%L, %L, %L)', :'ta', 'Ruta Mala', 'Otra'),
  '22023', null, 'an address with capitals or spaces is refused');
select throws_ok(format('select public.create_passport_circuit(%L, %L, %L)', :'ta', 'otra', E'Dos\nlíneas'),
  '22023', null, 'a name in two lines is refused');
select is(public.save_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 1, 'Ruta histórica',
  'De la plaza al museo.', 'Una postal.', array[(select id from ids where name = 'plaza'),
  (select id from ids where name = 'museo'), (select id from ids where name = 'iglesia')]), 2,
  'an editor saves the draft with its stops');
select throws_ok(format('select public.save_passport_circuit(%L, %L, 1, %L, %L, %L, %L::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Ruta', '', '', '{}'), 'PT409', null, 'with an old edit number, nothing changes');
select throws_ok(format('select public.save_passport_circuit(%L, %L, 2, %L, %L, %L, array[%L]::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Ruta', '', '', (select id from ids where name = 'feria')),
  '22023', null, 'an event is not a stop');
select throws_ok(format('select public.save_passport_circuit(%L, %L, 2, %L, %L, %L, array[%L]::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Ruta', '', '', (select id from ids where name = 'laguna')),
  '22023', null, 'another municipality''s destination is not a stop');
select throws_ok(format('select public.save_passport_circuit(%L, %L, 2, %L, %L, %L, array[%L, %L]::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Ruta', '', '', (select id from ids where name = 'plaza'),
  (select id from ids where name = 'plaza')), '22023', null, 'a destination is a stop only once');
select throws_ok(format('select public.save_passport_circuit(%L, %L, 2, %L, %L, %L, %L::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Ruta', E'Dos\nlíneas', '', '{}'), '22023', null,
  'the description is one line');
select throws_ok(format('select public.save_passport_circuit(%L, %L, 2, %L, %L, %L, %L::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Ruta', '', repeat('x', 201), '{}'), '22023', null,
  'the prize has at most 200 characters');
select throws_ok(format('select public.publish_passport_circuit(%L, %L, 2)', :'ta', (select id from ids where name = 'ruta')),
  '42501', null, 'an editor does not publish');

-- ── Reading ────────────────────────────────────────────────────────────────
set local request.jwt.claims to :'analysta';
select is(jsonb_array_length(public.tenant_passport_circuits(:'ta')), 1, 'an analyst reads the circuits');
select is((public.tenant_passport_circuits(:'ta') -> 0 -> 'stops' -> 2 ->> 'published')::boolean, false,
  'with which stops are not published');
select throws_ok(format('select public.create_passport_circuit(%L, %L, %L)', :'ta', 'otra', 'Otra'),
  '42501', null, 'an analyst does not create');
select throws_ok('select * from public.passport_circuits', '42501', null, 'nobody reads the table directly');
select throws_ok('select * from public.passport_circuit_stops', '42501', null, 'nor its stops');
set local request.jwt.claims to :'ownerb';
select throws_ok(format('select public.tenant_passport_circuits(%L)', :'ta'), '42501', null,
  'another municipality does not read them');
select throws_ok(format('select public.save_passport_circuit(%L, %L, 2, %L, %L, %L, %L::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Mía', '', '', '{}'), '42501', null, 'nor changes them');
set local request.jwt.claims to :'ownera1';
select throws_ok(format('select public.publish_passport_circuit(%L, %L, 2)', :'ta', (select id from ids where name = 'ruta')),
  '42501', null, 'an owner without her second factor does not publish');

-- ── Not on the portal until published ──────────────────────────────────────
set local role anon;
select is(public.portal_passport(:'ta'), '[]'::jsonb, 'visitors see no draft circuit');

-- ── Publishing ─────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'corta', public.create_passport_circuit(:'ta', 'ruta-corta', 'Ruta corta');
select is(public.save_passport_circuit(:'ta', (select id from ids where name = 'corta'), 1, 'Ruta corta', '', '',
  array[(select id from ids where name = 'plaza'), (select id from ids where name = 'iglesia')]), 2, 'a second circuit');
select throws_ok(format('select public.publish_passport_circuit(%L, %L, 2)', :'ta', (select id from ids where name = 'corta')),
  '23514', null, 'with one published destination it is not published');
select is(public.publish_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 2), 3,
  'the owner publishes the one with two');
select is((select count(*)::integer from public.audit_events where action = 'passport.circuit_published' and tenant_id = :'ta'), 1,
  'publishing is audited');

set local role anon;
select is(jsonb_array_length(public.portal_passport(:'ta')), 1, 'visitors see the published circuit');
select is((select array_agg(s ->> 'slug' order by o) from jsonb_array_elements(public.portal_passport(:'ta') -> 0 -> 'stops')
            with ordinality as x (s, o)), array['plaza', 'museo'],
  'with its published stops in order, never the draft destination');
select is(public.portal_passport(:'ta') -> 0 ->> 'reward', 'Una postal.', 'and its prize');
select is(public.portal_passport(:'tb'), '[]'::jsonb, 'another municipality has none');

-- ── Changing what is published ─────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'editora';
select throws_ok(format('select public.save_passport_circuit(%L, %L, 3, %L, %L, %L, %L::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Cambiado', '', '', '{}'), '42501', null,
  'an editor does not change a published circuit');
set local request.jwt.claims to :'ownera';
select throws_ok(format('select public.save_passport_circuit(%L, %L, 3, %L, %L, %L, array[%L]::uuid[])', :'ta',
  (select id from ids where name = 'ruta'), 'Ruta', '', '', (select id from ids where name = 'plaza')),
  '23514', null, 'a published circuit keeps two published destinations');
select is(public.save_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 3, 'Ruta histórica', '',
  'Un llavero.', array[(select id from ids where name = 'museo'), (select id from ids where name = 'plaza')]), 4,
  'the owner changes it');
set local role anon;
select is(public.portal_passport(:'ta') -> 0 ->> 'reward', 'Un llavero.', 'visitors see the change at once');

-- A published circuit left with one published destination leaves the portal.
reset role;
update public.content_items set published_revision_id = null, published_at = null where id = (select id from ids where name = 'museo');
set local role anon;
select is(public.portal_passport(:'ta'), '[]'::jsonb, 'without two published stops it is not shown');
reset role;
update public.content_items c set published_revision_id = r.id, published_at = now()
from public.content_revisions r where r.content_id = c.id and r.state = 'sealed' and c.id = (select id from ids where name = 'museo');

-- Suspended municipality.
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is(public.portal_passport(:'ta'), '[]'::jsonb, 'a suspended municipality shows none');
reset role;
update public.tenants set status = 'active' where id = :'ta';

-- ── Withdrawing and deleting ───────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'ownera';
select is(public.withdraw_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 4), 5,
  'the owner withdraws it');
set local role anon;
select is(public.portal_passport(:'ta'), '[]'::jsonb, 'and visitors no longer see it');
set local role authenticated;
select throws_ok(format('select public.delete_passport_circuit(%L, %L, 5)', :'ta', (select id from ids where name = 'ruta')),
  '23514', null, 'one that was published is withdrawn, not deleted');
set local request.jwt.claims to :'editora';
select throws_ok(format('select public.delete_passport_circuit(%L, %L, 2)', :'ta', (select id from ids where name = 'corta')),
  '42501', null, 'an editor does not delete');
set local request.jwt.claims to :'ownera';
select lives_ok(format('select public.delete_passport_circuit(%L, %L, 2)', :'ta', (select id from ids where name = 'corta')),
  'the owner deletes a draft never published');
select is(jsonb_array_length(public.tenant_passport_circuits(:'ta')), 1, 'with its stops');

select * from finish();
rollback;
