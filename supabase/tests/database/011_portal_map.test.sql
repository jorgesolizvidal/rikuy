-- Portal map: places by area (published destinations and events not ended yet),
-- kinds and limits, invalid areas, extent, isolation between tenants.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
insert into public.tenant_domains (id, tenant_id, hostname, kind, status, verified_at) values
  ('aaaaaaaa-0000-4000-8000-0000000000d1', :'ta', 'tenant-a.localhost', 'platform', 'active', now()),
  ('bbbbbbbb-0000-4000-8000-0000000000d1', :'tb', 'tenant-b.localhost', 'platform', 'active', now());
update public.tenants set canonical_domain_id = 'aaaaaaaa-0000-4000-8000-0000000000d1' where id = :'ta';
update public.tenants set canonical_domain_id = 'bbbbbbbb-0000-4000-8000-0000000000d1' where id = :'tb';
update public.tenants set status = 'active';
set constraints all immediate;

select to_char(now() at time zone 'America/La_Paz' + interval '3 days', 'YYYY-MM-DD') as soon,
       to_char(now() at time zone 'America/La_Paz' - interval '3 days', 'YYYY-MM-DD') as past
\gset

select plan(16);

set local role authenticated;
set local request.jwt.claims to :'a1c';
-- Tenant A: two destinations (one far away), an upcoming event, an ended event, a draft.
select content_id as plaza from public.create_content_item(:'ta', 'destination', 'plaza', 'Plaza') \gset
select public.save_content_draft(:'ta', :'plaza',
  '{"title":"Plaza","summary":"Centro","body":[],"location":{"lat":-17.40,"lng":-66.15},"cover":null,"gallery":[]}'::jsonb, 1);
select public.publish_content(:'ta', :'plaza', 2);
select content_id as lejos from public.create_content_item(:'ta', 'destination', 'lejos', 'Lejos') \gset
select public.save_content_draft(:'ta', :'lejos',
  '{"title":"Lejos","summary":"Otra zona","body":[],"location":{"lat":-19.00,"lng":-65.00},"cover":null,"gallery":[]}'::jsonb, 1);
select public.publish_content(:'ta', :'lejos', 2);
select content_id as feria from public.create_content_item(:'ta', 'event', 'feria', 'Feria') \gset
select public.save_content_draft(:'ta', :'feria', format(
  '{"title":"Feria","summary":"Pronto","body":[],"location":{"lat":-17.41,"lng":-66.16},"cover":null,"gallery":[],"schedule":{"allDay":true,"start":"%s","end":"%s"},"venueId":null}',
  :'soon', :'soon')::jsonb, 1);
select public.publish_content(:'ta', :'feria', 2);
select content_id as pasada from public.create_content_item(:'ta', 'event', 'pasada', 'Pasada') \gset
select public.save_content_draft(:'ta', :'pasada', format(
  '{"title":"Pasada","summary":"Terminó","body":[],"location":{"lat":-17.40,"lng":-66.15},"cover":null,"gallery":[],"schedule":{"allDay":true,"start":"%s","end":"%s"},"venueId":null}',
  :'past', :'past')::jsonb, 1);
select public.publish_content(:'ta', :'pasada', 2);
select content_id as borrador from public.create_content_item(:'ta', 'destination', 'borrador', 'Borrador') \gset
select public.save_content_draft(:'ta', :'borrador',
  '{"title":"Borrador","summary":"Sin publicar","body":[],"location":{"lat":-17.40,"lng":-66.15},"cover":null,"gallery":[]}'::jsonb, 1);
-- Tenant B: a destination at the very same spot.
set local request.jwt.claims to :'b1c';
select content_id as ajena from public.create_content_item(:'tb', 'destination', 'ajena', 'Ajena') \gset
select public.save_content_draft(:'tb', :'ajena',
  '{"title":"Ajena","summary":"De B","body":[],"location":{"lat":-17.40,"lng":-66.15},"cover":null,"gallery":[]}'::jsonb, 1);
select public.publish_content(:'tb', :'ajena', 2);

set local role anon;
select is(
  (select array_agg(slug order by slug) from public.portal_map_places(:'ta', -66.5, -17.6, -66.0, -17.2)),
  array['feria', 'plaza'],
  'the area shows published destinations and upcoming events inside it');
select is(
  (select array_agg(slug order by slug) from public.portal_map_places(:'ta', -70, -23, -57, -9)),
  array['feria', 'lejos', 'plaza'],
  'a larger area includes the far destination; never drafts or ended events');
select is((select kind from public.portal_map_places(:'ta', -66.5, -17.6, -66.0, -17.2) where slug = 'feria'),
  'event', 'each place says what it is');
select ok((select schedule is not null and starts_at is not null from public.portal_map_places(:'ta', -66.5, -17.6, -66.0, -17.2) where slug = 'feria'),
  'events carry their schedule and start');
select is(
  (select array_agg(slug) from public.portal_map_places(:'ta', -66.5, -17.6, -66.0, -17.2, array['destination'])),
  array['plaza'], 'layers: only destinations');
select is(
  (select array_agg(slug) from public.portal_map_places(:'ta', -66.5, -17.6, -66.0, -17.2, array['event'])),
  array['feria'], 'layers: only events');
select is((select count(*)::int from public.portal_map_places(:'ta', -70, -23, -57, -9, array['destination', 'event'], 1)),
  1, 'results are capped');
select is((select count(*)::int from public.portal_map_places(:'ta', -60, -17.6, -59, -17.2)), 0, 'an empty area returns nothing');
select is(
  (select array_agg(slug) from public.portal_map_places(:'tb', -66.5, -17.6, -66.0, -17.2)),
  array['ajena'], 'another tenant only sees its own places at the same spot');

select throws_ok($$select * from public.portal_map_places('aaaaaaaa-0000-4000-8000-000000000001', -66, -17.2, -66.5, -17.6)$$,
  '22023', null, 'west after east (or south after north) is refused');
select throws_ok($$select * from public.portal_map_places('aaaaaaaa-0000-4000-8000-000000000001', -200, -17.6, -66, -17.2)$$,
  '22023', null, 'coordinates out of range are refused');
select throws_ok($$select * from public.portal_map_places('aaaaaaaa-0000-4000-8000-000000000001', -66.5, -17.6, -66, -17.2, array['destination'], 501)$$,
  '22023', null, 'at most 500 places per request');
select throws_ok($$select * from public.portal_map_places('aaaaaaaa-0000-4000-8000-000000000001', -66.5, -17.6, -66, -17.2, array['tour'])$$,
  '22023', null, 'unknown layers are refused');

select is(
  (select row(west, south, east, north, destinations, events)::text from public.portal_map_extent(:'ta')),
  row(-66.16::float8, -19.0::float8, -65.0::float8, -17.40::float8, 2, 1)::text,
  'the extent frames every place (and counts them by kind)');

reset role;
update public.tenants set status = 'suspended' where id = :'ta';
set local role anon;
select is((select count(*)::int from public.portal_map_places(:'ta', -70, -23, -57, -9)), 0, 'a suspended portal shows no places');
select is((select destinations + events from public.portal_map_extent(:'ta')), 0, 'and has no extent');

select * from finish();
rollback;
