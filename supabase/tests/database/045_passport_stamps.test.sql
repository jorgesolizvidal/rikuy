-- Stamps of the tourist passport (C2 · Paso 2, ADR-057): every stop has a random stamp code
-- that only owners, admins and editors see and only owners and admins renew; the portal stamps
-- only with a current code of a published destination that is a stop of a published circuit,
-- of an online municipality; the stamp is signed with the municipality's key and the
-- signature does not survive a changed field. Nothing of the visitor is stored.
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
\set passport 'AbCdEfGhIjKlMnOpQrSt_-'

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
-- Results of setup calls (kept off the TAP output).
create temp table scratch (v integer);
grant insert on scratch to authenticated, anon;

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'plaza', content_id from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza');
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'iglesia', content_id from public.create_content_item(:'ta', 'destination', 'iglesia', 'Iglesia');
insert into ids select 'molino', content_id from public.create_content_item(:'ta', 'destination', 'molino', 'Molino');
set local request.jwt.claims to :'ownerb';
insert into ids select 'laguna', content_id from public.create_content_item(:'tb', 'destination', 'laguna', 'Laguna');
insert into ids select 'mirador', content_id from public.create_content_item(:'tb', 'destination', 'mirador', 'Mirador');
reset role;
-- Published: plaza, museum and mill (A); lagoon and lookout (B). The church only a draft.
insert into public.content_revisions (id, tenant_id, content_id, revision_no, state, title, summary, latitude, longitude, sealed_at)
select gen_random_uuid(), i.tenant_id, i.id, 2, 'sealed', initcap(i.slug), 'Texto.', -17.5, -65.9, now()
from public.content_items i where i.id in (select id from ids where name in ('plaza', 'museo', 'molino', 'laguna', 'mirador'));
update public.content_items c set published_revision_id = r.id, published_at = now()
from public.content_revisions r
where r.content_id = c.id and r.state = 'sealed' and c.id in (select id from ids);

-- A: «Ruta» (published) with plaza, museum and church; «Borrador» (draft) with the mill.
-- B: «Lagos» (published) with lagoon and lookout.
set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into ids select 'ruta', public.create_passport_circuit(:'ta', 'ruta', 'Ruta');
insert into scratch select public.save_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 1, 'Ruta', '', '',
  array[(select id from ids where name = 'plaza'), (select id from ids where name = 'museo'),
        (select id from ids where name = 'iglesia')]);
insert into scratch select public.publish_passport_circuit(:'ta', (select id from ids where name = 'ruta'), 2);
insert into ids select 'borrador', public.create_passport_circuit(:'ta', 'borrador', 'Borrador');
insert into scratch select public.save_passport_circuit(:'ta', (select id from ids where name = 'borrador'), 1, 'Borrador', '', '',
  array[(select id from ids where name = 'molino')]);
set local request.jwt.claims to :'ownerb';
insert into ids select 'lagos', public.create_passport_circuit(:'tb', 'lagos', 'Lagos');
insert into scratch select public.save_passport_circuit(:'tb', (select id from ids where name = 'lagos'), 1, 'Lagos', '', '',
  array[(select id from ids where name = 'laguna'), (select id from ids where name = 'mirador')]);
insert into scratch select public.publish_passport_circuit(:'tb', (select id from ids where name = 'lagos'), 2);
reset role;

create temp table codes as
select i.name, k.code, k.version from public.passport_stamp_codes k join ids i on i.id = k.content_id;
grant select on codes to authenticated, anon;

select plan(39);

-- ── Codes ──────────────────────────────────────────────────────────────────
select is((select count(*)::int from codes), 6, 'every stop got a stamp code (also of a draft circuit)');
select ok((select bool_and(code ~ '^[A-Za-z0-9_-]{22}$') from codes), 'codes are 22 characters of base64url');
select is((select count(distinct code)::int from codes), 6, 'no two codes are the same');

set local role authenticated;
set local request.jwt.claims to :'ownera';
insert into scratch select public.save_passport_circuit(:'ta', (select id from ids where name = 'borrador'), 2, 'Borrador', '', '', '{}'::uuid[]);
insert into scratch select public.save_passport_circuit(:'ta', (select id from ids where name = 'borrador'), 3, 'Borrador', '', '',
  array[(select id from ids where name = 'molino')]);
reset role;
select is((select k.code from public.passport_stamp_codes k where k.content_id = (select id from ids where name = 'molino')),
  (select code from codes where name = 'molino'), 'taking a stop out and back keeps its printed code');

set local role anon;
select throws_ok('select * from public.passport_stamp_codes', '42501', null, 'visitors do not read the codes');
set local role authenticated;
set local request.jwt.claims to :'ownera';
select throws_ok('select * from public.passport_stamp_codes', '42501', null, 'members do not read the table either');
select throws_ok('select * from private.passport_keys', '42501', null, 'nobody reads the signing keys');

-- ── The panel ──────────────────────────────────────────────────────────────
select is(jsonb_array_length(public.tenant_passport_stamp_codes(:'ta')), 4, 'the owner sees the codes of the four stops');
select is((select e->>'code' from jsonb_array_elements(public.tenant_passport_stamp_codes(:'ta')) e where e->>'slug' = 'plaza'),
  (select code from codes where name = 'plaza'), 'with the code to print');
select is((select e->'circuits'->0->>'name' from jsonb_array_elements(public.tenant_passport_stamp_codes(:'ta')) e where e->>'slug' = 'molino'),
  'Borrador', 'and the circuits that use it');
select is((select (e->>'published')::boolean from jsonb_array_elements(public.tenant_passport_stamp_codes(:'ta')) e where e->>'slug' = 'iglesia'),
  false, 'a draft destination is marked unpublished');
set local request.jwt.claims to :'editora';
select is(jsonb_array_length(public.tenant_passport_stamp_codes(:'ta')), 4, 'an editor sees the codes (to print them)');
set local request.jwt.claims to :'analysta';
select throws_ok(format('select public.tenant_passport_stamp_codes(%L)', :'ta'), '42501', null, 'an analyst does not see the codes');
set local request.jwt.claims to :'ownera1';
select throws_ok(format('select public.tenant_passport_stamp_codes(%L)', :'ta'), '42501', null,
  'an owner without the second factor does not see them');
set local request.jwt.claims to :'ownerb';
select throws_ok(format('select public.tenant_passport_stamp_codes(%L)', :'ta'), '42501', null,
  'another municipality''s owner does not see them');

-- Renewing.
set local request.jwt.claims to :'editora';
select throws_ok(format('select public.renew_passport_stamp_code(%L, %L, 1)', :'ta', (select id from ids where name = 'plaza')),
  '42501', null, 'an editor does not renew a code');
set local request.jwt.claims to :'ownerb';
select throws_ok(format('select public.renew_passport_stamp_code(%L, %L, 1)', :'tb', (select id from ids where name = 'plaza')),
  'P0002', null, 'another municipality''s place is not found');
set local request.jwt.claims to :'ownera';
select throws_ok(format('select public.renew_passport_stamp_code(%L, %L, 2)', :'ta', (select id from ids where name = 'plaza')),
  'PT409', null, 'with an old version, nothing changes');
select is(public.renew_passport_stamp_code(:'ta', (select id from ids where name = 'plaza'), 1), 2, 'the owner renews the code');
select isnt((select e->>'code' from jsonb_array_elements(public.tenant_passport_stamp_codes(:'ta')) e where e->>'slug' = 'plaza'),
  (select code from codes where name = 'plaza'), 'the code is a new one');
reset role;
select is((select count(*)::int from public.audit_events where action = 'passport.stamp_code_renewed'
           and entity_id = (select id from ids where name = 'plaza')), 1, 'renewing is audited');

-- ── The portal ─────────────────────────────────────────────────────────────
set local role anon;
select is(public.portal_stamp_place(:'ta', (select code from codes where name = 'museo'))->>'slug', 'museo',
  'a current code shows its place to a visitor');
select is(public.portal_stamp_place(:'ta', (select code from codes where name = 'plaza')), null,
  'a renewed code shows nothing');
select is(public.portal_stamp_place(:'ta', (select code from codes where name = 'iglesia')), null,
  'nor the code of a draft destination');
select is(public.portal_stamp_place(:'ta', (select code from codes where name = 'molino')), null,
  'nor that of a destination only in a draft circuit');
select is(public.portal_stamp_place(:'tb', (select code from codes where name = 'museo')), null,
  'nor a code of another municipality');
select is(jsonb_array_length(public.portal_passport(:'ta')->0->'stops'), 2, 'the circuit shows its two published stops');
select is(public.portal_passport(:'ta')->0->'stops'->1->>'id', (select id::text from ids where name = 'museo'),
  'each with its place');

create temp table stamp as
select public.portal_collect_stamp(:'ta', (select code from codes where name = 'museo'), :'passport', true) as s;
select is((select s->>'id' from stamp), (select id::text from ids where name = 'museo'), 'a visitor collects a stamp');
select ok((select (s->>'located')::boolean from stamp), 'saying it was near');
select ok((select s->>'signature' ~ '^[A-Za-z0-9_-]{43}$' from stamp), 'signed');
reset role;
select ok((select private.passport_stamp_valid(:'ta', (s->>'id')::uuid, :'passport', (s->>'at')::bigint, true, s->>'signature') from stamp),
  'the signature is the municipality''s');
select ok((select not private.passport_stamp_valid(:'ta', (s->>'id')::uuid, :'passport', (s->>'at')::bigint, false, s->>'signature') from stamp),
  'a stamp «without location» changed to «near» is not valid');
select ok((select not private.passport_stamp_valid(:'ta', (s->>'id')::uuid, 'ZZZZZZZZZZZZZZZZZZZZZZ', (s->>'at')::bigint, true, s->>'signature') from stamp),
  'nor one copied to another passport');
select ok((select not private.passport_stamp_valid(:'tb', (s->>'id')::uuid, :'passport', (s->>'at')::bigint, true, s->>'signature') from stamp),
  'nor one shown to another municipality');
select is((select count(*)::int from private.passport_keys), 1, 'one key for the municipality, nothing of the visitor');

set local role anon;
select throws_ok(format('select public.portal_collect_stamp(%L, %L, %L, true)', :'ta', (select code from codes where name = 'museo'), 'corto'),
  '22023', null, 'an invalid passport id is refused');
select is(public.portal_collect_stamp(:'ta', (select code from codes where name = 'plaza'), :'passport', false), null,
  'a renewed code does not stamp');
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is(public.portal_collect_stamp(:'ta', (select code from codes where name = 'museo'), :'passport', false), null,
  'a suspended municipality does not stamp');
reset role;

select * from finish();
rollback;
