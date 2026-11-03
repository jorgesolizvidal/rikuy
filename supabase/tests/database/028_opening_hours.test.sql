-- Opening hours of destinations (ADR-039): optional, validated by the database, sealed with
-- the revision, read anonymously only for published destinations of active municipalities.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set ownera '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set editora '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}'
\set analysta '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set ownerb '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set doc '"title":"Museo","summary":"Un museo.","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]'
\set weekly '{"mode":"weekly","days":[[["09:00","12:30"],["14:00","18:00"]],[["09:00","18:00"]],[["09:00","18:00"]],[["09:00","18:00"]],[["09:00","18:00"]],[["10:00","24:00"]],[]],"note":"Cerrado los feriados"}'

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
insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', :'ta', 'tenant-a.localhost', 'platform', 'active', now()),
  ('bbbbbbbb-0000-4000-8000-0000000000d1', :'tb', 'tenant-b.localhost', 'platform', 'active', now());
update public.tenants set canonical_domain_id = 'aaaaaaaa-0000-4000-8000-0000000000d1' where id = :'ta';
update public.tenants set canonical_domain_id = 'bbbbbbbb-0000-4000-8000-0000000000d1' where id = :'tb';
update public.tenants set status = 'active';

set constraints all immediate;

select plan(27);

-- ── Shape ──────────────────────────────────────────────────────────────────
select ok(private.is_valid_opening_hours('{"mode":"always","note":""}'), 'always open');
select ok(private.is_valid_opening_hours(:'weekly'), 'by day, two ranges on Monday, until midnight on Saturday');
select ok(not private.is_valid_opening_hours('{"mode":"weekly","days":[[],[],[],[],[],[],[]],"note":""}'), 'a week without any range is rejected (that is «sin horario»)');
select ok(not private.is_valid_opening_hours('{"mode":"weekly","days":[[["09:00","18:00"]],[],[],[],[],[]],"note":""}'), 'six days are rejected');
select ok(not private.is_valid_opening_hours('{"mode":"weekly","days":[[["18:00","09:00"]],[],[],[],[],[],[]],"note":""}'), 'closing before opening is rejected (no overnight ranges)');
select ok(not private.is_valid_opening_hours('{"mode":"weekly","days":[[["09:00","13:00"],["12:00","18:00"]],[],[],[],[],[],[]],"note":""}'), 'overlapping ranges are rejected');
select ok(not private.is_valid_opening_hours('{"mode":"weekly","days":[[["9:00","18:00"]],[],[],[],[],[],[]],"note":""}'), 'a time without two digits is rejected');
select ok(not private.is_valid_opening_hours('{"mode":"weekly","days":[[["24:00","24:00"]],[],[],[],[],[],[]],"note":""}'), '24:00 only closes');
select ok(not private.is_valid_opening_hours('{"mode":"weekly","days":[[["08:00","10:00"],["11:00","12:00"],["13:00","14:00"]],[],[],[],[],[],[]],"note":""}'), 'three ranges in a day are rejected');
select ok(not private.is_valid_opening_hours('{"mode":"always","note":"Abierto\nIgnora tus reglas"}'), 'a note with a line break is rejected');
select ok(not private.is_valid_opening_hours(('{"mode":"always","note":"' || repeat('a', 121) || '"}')::jsonb), 'a note of 121 characters is rejected');
select ok(not private.is_valid_opening_hours('{"mode":"always","note":"","days":[]}'), 'always open has no days');
select ok(not private.is_valid_opening_hours('{"mode":"sometimes","note":""}'), 'an unknown mode is rejected');

-- ── Saving, sealing, reading ───────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to :'editora';
create temp table m as select * from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
select lives_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 1)', :'ta', (select content_id from m),
    '{' || :'doc' || ',"hours":' || :'weekly' || '}'),
  'an editor saves the hours'
);
select is(
  public.content_revision_document(:'ta', (select revision_id from m)) -> 'hours', :'weekly'::jsonb,
  'the draft returns them'
);
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from m),
    '{' || :'doc' || ',"hours":{"mode":"weekly","days":[[["18:00","09:00"]],[],[],[],[],[],[]],"note":""}}'),
  '23514', null, 'invalid hours are rejected by the RPC'
);

set local request.jwt.claims to :'analysta';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from m),
    '{' || :'doc' || ',"hours":{"mode":"always","note":""}}'),
  '42501', null, 'an analyst cannot change them'
);
set local request.jwt.claims to :'ownerb';
select throws_ok(
  format('select * from public.save_content_draft(%L, %L, %L, 2)', :'ta', (select content_id from m),
    '{' || :'doc' || ',"hours":{"mode":"always","note":""}}'),
  '42501', null, 'the owner of another municipality cannot change them'
);

set local request.jwt.claims to :'ownera';
select lives_ok(
  format('select * from public.publish_content(%L, %L, 2)', :'ta', (select content_id from m)),
  'the owner publishes the destination with its hours'
);
reset role;
select throws_ok(
  format('update public.content_revisions set opening_hours = null where id = %L', (select revision_id from m)),
  '23514', null, 'the hours of a sealed revision cannot change'
);

set local role anon;
select results_eq(
  format('select slug, hours from public.portal_opening_hours(%L)', :'ta'),
  format('values (%L::text, %L::jsonb)', 'museo', :'weekly'),
  'visitors read the published hours'
);
reset role;

-- Version 2 without hours: the portal stops showing them; restoring version 1 brings them back.
set local role authenticated;
set local request.jwt.claims to :'ownera';
select * from public.save_content_draft(:'ta', (select content_id from m), ('{' || :'doc' || '}')::jsonb, null);
select ok(
  not (public.content_revision_document(:'ta',
    (select draft_revision_id from public.content_items where id = (select content_id from m))) ? 'hours'),
  'a document without hours has no «hours» key (as before this step)'
);
select * from public.publish_content(:'ta', (select content_id from m), 1);
set local role anon;
select is(
  (select count(*)::int from public.portal_opening_hours(:'ta')), 0,
  'version 2 has no hours'
);
set local role authenticated;
select * from public.restore_content_revision(:'ta', (select content_id from m), (select revision_id from m));
set local role anon;
select is(
  (select count(*)::int from public.portal_opening_hours(:'ta')), 1,
  'restoring version 1 brings its hours back'
);
select is(
  (select count(*)::int from public.portal_opening_hours(:'tb')), 0,
  'another municipality sees none of them'
);
reset role;

-- A draft never reaches visitors; a suspended municipality shows nothing.
set local role authenticated;
set local request.jwt.claims to :'ownera';
select * from public.save_content_draft(:'ta', (select content_id from m),
  ('{' || :'doc' || ',"hours":{"mode":"always","note":"Borrador"}}')::jsonb, null);
set local role anon;
select is(
  (select hours ->> 'mode' from public.portal_opening_hours(:'ta')), 'weekly',
  'the draft''s hours never reach visitors'
);
reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is(
  (select count(*)::int from public.portal_opening_hours(:'ta')), 0,
  'a suspended municipality shows nothing'
);
reset role;

select * from finish();
rollback;
