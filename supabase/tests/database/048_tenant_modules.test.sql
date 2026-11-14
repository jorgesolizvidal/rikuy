-- The modules each municipality has (C3 · Paso 1, ADR-060): every municipality starts with
-- all of them; only the platform operator (second factor) changes the set, checked against
-- the catalog and its requirements, and audited; provisioning can start with a package; the
-- portal and the panel read the set; content of a module that is off cannot be created, and
-- turning a module off deletes nothing.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set op  '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal2"}'
\set op1 '{"sub":"00000000-0000-4000-8000-0000000000f1","role":"authenticated","aal":"aal1"}'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000f1', 'operador@example.test'),
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test'),
  ('00000000-0000-4000-8000-0000000000c1', 'nuevo@example.test');
insert into public.platform_operators (user_id, status) values
  ('00000000-0000-4000-8000-0000000000f1', 'active');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.tenant_domains (tenant_id, hostname, kind, status, verified_at) values
  (:'ta', 'a.modulos.test', 'platform', 'active', now());
update public.tenants t set canonical_domain_id = d.id
from public.tenant_domains d where d.tenant_id = t.id and t.id = :'ta';
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'editor', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active';
set constraints all immediate;

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated, anon;

\set everything '{agenda,map,tours,models,passport,assistant,voice,copilot}'

select plan(40);

-- ── Everyone starts with everything ────────────────────────────────────────
select is(private.tenant_module_keys(:'ta'), :'everything'::text[], 'a new municipality has every module, in order');
select is((select count(*)::int from public.tenant_modules m join public.tenants t on t.id = m.tenant_id
           where t.slug in ('demo-norte', 'demo-sur')), 16, 'the municipalities that already exist keep everything');
select throws_ok('set local role anon; select * from public.tenant_modules', '42501', null,
  'visitors do not read the modules table');
select throws_ok('set local role authenticated; select * from public.platform_modules', '42501', null,
  'nor does anyone read the catalog directly');

-- ── Only the operator changes them ─────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'ownera';
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', :'ta', '{agenda}'),
  '42501', null, 'the owner of the municipality cannot change its modules');
set local request.jwt.claims to :'op1';
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', :'ta', '{agenda}'),
  '42501', null, 'nor can an operator without the second factor');
set local role anon;
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', :'ta', '{agenda}'),
  '42501', null, 'nor a visitor');

set local role authenticated;
set local request.jwt.claims to :'op';
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', :'ta', '{agenda,cine}'),
  '23514', null, 'an unknown module is refused');
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', :'ta', '{agenda,agenda}'),
  '23514', null, 'a repeated one too');
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', :'ta', '{agenda,models}'),
  '23514', null, '3D models need the tours');
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', :'ta', '{voice}'),
  '23514', null, 'the voice needs the assistant');
select throws_ok(format('select public.platform_set_tenant_modules(%L, null)', :'ta'),
  '23514', null, 'no set at all is refused');
select throws_ok(format('select public.platform_set_tenant_modules(%L, %L)', gen_random_uuid(), '{agenda}'),
  'PT404', null, 'an unknown municipality is refused');
reset role;
select is(private.tenant_module_keys(:'ta'), :'everything'::text[], 'nothing changed after the refusals');
set local role authenticated;

-- Before turning modules off, A has content of each one.
set local request.jwt.claims to :'ownera';
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'feria', content_id from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
insert into ids select 'circuito', public.create_passport_circuit(:'ta', 'ruta', 'Ruta');
set local request.jwt.claims to :'op';

select is(public.platform_set_tenant_modules(:'ta', '{map,agenda,tours}'), '{agenda,map,tours}'::text[],
  'the operator sets a «solo información» package with tours (returned in the catalog order)');
reset role;
select is((select diff from public.audit_events where action = 'platform.modules_changed' and tenant_id = :'ta'),
  jsonb_build_object('from', to_jsonb(:'everything'::text[]), 'to', to_jsonb('{agenda,map,tours}'::text[])),
  'it is audited with the set before and after');
set local role authenticated;
select is(public.platform_set_tenant_modules(:'ta', '{agenda,map,tours}'), '{agenda,map,tours}'::text[],
  'saving the same set again');
reset role;
select is((select count(*)::int from public.audit_events where action = 'platform.modules_changed' and tenant_id = :'ta'), 1,
  'is not audited twice');
select is(private.tenant_module_keys(:'tb'), :'everything'::text[], 'the other municipality keeps everything');
set local role authenticated;

-- ── The portal and the panel read the set ──────────────────────────────────
set local role anon;
select is((select modules from public.resolve_tenant_by_host('a.modulos.test')), '{agenda,map,tours}'::text[],
  'the portal learns the set with the host');
set local role authenticated;
set local request.jwt.claims to :'editora';
select is((select modules from public.my_memberships() where tenant_id = :'ta'), '{agenda,map,tours}'::text[],
  'the panel reads it with the memberships');
set local request.jwt.claims to :'op';
select is((select modules from public.platform_list_tenants() where tenant_id = :'ta'), '{agenda,map,tours}'::text[],
  'and the operator with the list of municipalities');

-- ── Nothing is deleted; nothing new of a module that is off ────────────────
reset role;
select ok(exists (select 1 from public.passport_circuits c where c.id = (select id from ids where name = 'circuito')),
  'the circuit created before is still there');
set local role authenticated;
set local request.jwt.claims to :'ownera';
select throws_ok(format('select public.create_passport_circuit(%L, %L, %L)', :'ta', 'otra', 'Otra'),
  'PT403', null, 'a new circuit is refused while the passport is off');
select throws_ok(format('select public.create_content_item(%L, %L, %L, %L)', :'ta', 'knowledge', 'guia', 'Guía'),
  'PT403', null, 'knowledge for the assistant too');
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'model', 'model/gltf-binary', 1000),
  'PT403', null, 'and a 3D model upload');
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'document', 'text/plain', 1000),
  'PT403', null, 'and a document for the assistant');
select lives_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'panorama', 'image/jpeg', 100000),
  'a panorama is still accepted: the tours are on');
select lives_ok(format('select public.create_content_item(%L, %L, %L, %L)', :'ta', 'event', 'otra-feria', 'Otra feria'),
  'and an event: the agenda is on');
set local request.jwt.claims to :'ownerb';
select lives_ok(format('select public.create_passport_circuit(%L, %L, %L)', :'tb', 'ruta', 'Ruta'),
  'the other municipality creates circuits as before');

set local request.jwt.claims to :'op';
select is(public.platform_set_tenant_modules(:'ta', '{map}'), '{map}'::text[], 'only the map left');
set local request.jwt.claims to :'ownera';
select throws_ok(format('select public.create_content_item(%L, %L, %L, %L)', :'ta', 'event', 'tercera', 'Tercera'),
  'PT403', null, 'no new event without the agenda');
select throws_ok(format('select public.create_tour(%L, %L)', :'ta', (select id from ids where name = 'plaza')),
  'PT403', null, 'no new tour without the tours');
select throws_ok(format('select * from public.create_image_upload(%L, %L, %L, %L)', :'ta', 'panorama', 'image/jpeg', 100000),
  'PT403', null, 'nor a new panorama');
select lives_ok(format('select public.create_content_item(%L, %L, %L, %L)', :'ta', 'destination', 'museo', 'Museo'),
  'destinations are always there');
reset role;
select ok(exists (select 1 from public.content_items c where c.id = (select id from ids where name = 'feria')),
  'the event created before is kept');
set local role authenticated;

-- Turned on again: everything comes back as it was.
set local request.jwt.claims to :'op';
select is(public.platform_set_tenant_modules(:'ta', :'everything'::text[]), :'everything'::text[], 'turned on again');
set local request.jwt.claims to :'ownera';
select lives_ok(format('select public.create_passport_circuit(%L, %L, %L)', :'ta', 'otra', 'Otra'),
  'and new circuits are accepted again');

-- ── Provisioning with a package ────────────────────────────────────────────
set local request.jwt.claims to :'op';
insert into ids select 'nuevo', tenant_id from public.provision_tenant(
     'nuevo', 'Nuevo', 'nuevo.modulos.test', '00000000-0000-4000-8000-0000000000c1',
     'es', 'America/La_Paz', false, '{agenda,map}');
reset role;
select is(private.tenant_module_keys((select id from ids where name = 'nuevo')), '{agenda,map}'::text[],
  'a municipality provisioned with «Solo información» starts with agenda and map');
set local role authenticated;
select throws_ok(
  $$select * from public.provision_tenant('otro', 'Otro', 'otro.modulos.test',
      '00000000-0000-4000-8000-0000000000c1', 'es', 'America/La_Paz', false, '{voice}')$$,
  '23514', null, 'an invalid package is refused before anything is created');

select * from finish();
rollback;
