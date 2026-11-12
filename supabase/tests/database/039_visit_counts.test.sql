-- C1 · Paso 1 (ADR-051): anonymous daily visit counts. Only rikuy_worker records them; only
-- published places of online municipalities, scenes of their published tour and the events
-- allowed on each page count; the day is the municipality's; a visitor is counted once per
-- day and target (as a daily-salted hash that is forgotten two days later) and never past the
-- daily cap; origins count on page views only, and nothing about a visitor is in the totals.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set tp 'cccccccc-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'
\set place '{"title":"%s","summary":"Un lugar","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'
\set event '{"title":"Feria","summary":"Una feria","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[],"schedule":{"allDay":true,"start":"2030-03-01","end":"2030-03-01"},"venueId":null}'
-- 23:30 in La Paz on Nov 14 is already Nov 15 in UTC: the day must be the municipality's.
\set late '2026-11-15T03:30:00Z'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'America/La_Paz'),
  (:'tp', 'tenant-p', 'Tenant P', 'provisioning', 'es', 'America/La_Paz');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now()),
  (:'tp', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now());
update public.tenants set status = 'active' where id in (:'ta', :'tb');
set constraints all immediate;
grant usage on schema extensions to rikuy_worker;
do $$ begin execute format('grant temporary on database %I to rikuy_worker', current_database()); end $$;

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;
grant select on ids to rikuy_worker;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create temp table media (tenant uuid, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (tenant) values (:'ta');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, 'panorama' from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, manifest, published_at)
select version_id, tenant, asset, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 8192, 4096, :'sha', now(), :'pano'::jsonb, now()
from media;
grant select on media to authenticated;

-- A: a published museum with a published tour of one scene, a published fair, a draft-only
-- place and a museum tour scene added later to the draft only. B: its own museum (same slug).
set local role authenticated;
set local request.jwt.claims to :'a1c';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'feria', content_id from public.create_content_item(:'ta', 'event', 'feria', 'Feria');
insert into ids select 'oculto', content_id from public.create_content_item(:'ta', 'destination', 'oculto', 'Oculto');
select * from public.save_content_draft(:'ta', pg_temp.id('museo'), format(:'place', 'Museo')::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('museo'), 2);
select * from public.save_content_draft(:'ta', pg_temp.id('feria'), :'event'::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('feria'), 2);
insert into ids select 'T', tour_id from public.create_tour(:'ta', pg_temp.id('museo'));
insert into ids select 'sala', scene_id from public.add_tour_scene(:'ta', pg_temp.id('T'), 1, (select version_id from media), 'Sala');
select * from public.publish_tour(:'ta', pg_temp.id('T'), 2);
set local request.jwt.claims to :'b1c';
insert into ids select 'museo_b', content_id from public.create_content_item(:'tb', 'destination', 'museo', 'Museo B');
select * from public.save_content_draft(:'tb', pg_temp.id('museo_b'), format(:'place', 'Museo B')::jsonb, 1);
select * from public.publish_content(:'tb', pg_temp.id('museo_b'), 2);
reset role;

select plan(30);

-- ── Who can record and read ───────────────────────────────────────────────
select ok(has_function_privilege('rikuy_worker', 'worker_api.record_visit(uuid, text, text, uuid, text, text, text, text, timestamptz)', 'EXECUTE'),
  'the worker role records visits');
select ok(not has_function_privilege('anon', 'worker_api.record_visit(uuid, text, text, uuid, text, text, text, text, timestamptz)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'worker_api.record_visit(uuid, text, text, uuid, text, text, text, text, timestamptz)', 'EXECUTE')
          and not has_function_privilege('service_role', 'worker_api.record_visit(uuid, text, text, uuid, text, text, text, text, timestamptz)', 'EXECUTE'),
  'visitors, people and the secret key cannot record visits');
select ok(not has_table_privilege('authenticated', 'public.visit_daily_counts', 'SELECT')
          and not has_table_privilege('anon', 'public.visit_daily_origins', 'SELECT')
          and not has_table_privilege('service_role', 'public.visit_daily_counts', 'INSERT')
          and not has_table_privilege('rikuy_worker', 'public.visit_daily_counts', 'SELECT'),
  'nobody reads or writes the totals directly');
select ok(not has_table_privilege('rikuy_worker', 'private.visit_marks', 'SELECT')
          and not has_table_privilege('authenticated', 'private.visit_salts', 'SELECT'),
  'nobody reads the marks or the salts');

-- ── What counts ───────────────────────────────────────────────────────────
set local role rikuy_worker;
select is(worker_api.record_visit(:'ta', 'home', null, null, 'view', 'BO', 'Cochabamba', '1.1.1.1|chrome', :'late'),
  'recorded', 'a view of the home page counts');
select is(worker_api.record_visit(:'ta', 'home', null, null, 'view', 'BO', 'Cochabamba', '1.1.1.1|chrome', :'late'),
  'recorded', 'the same visitor again counts as a view');
select is(worker_api.record_visit(:'ta', 'home', null, null, 'view', 'AR', 'Salta', '2.2.2.2|firefox', :'late'),
  'recorded', 'another visitor counts');
select is(worker_api.record_visit(:'ta', 'destination', 'museo', null, 'view', 'BO', 'Cochabamba', '1.1.1.1|chrome', :'late'),
  'recorded', 'a published place counts');
select is(worker_api.record_visit(:'ta', 'destination', 'museo', null, 'directions', null, null, '1.1.1.1|chrome', :'late'),
  'recorded', '«Cómo llegar» on a place counts');
select is(worker_api.record_visit(:'ta', 'event', 'feria', null, 'calendar', null, null, '1.1.1.1|chrome', :'late'),
  'recorded', '«Añadir al calendario» on an event counts');
select is(worker_api.record_visit(:'ta', 'destination_tour', 'museo', pg_temp.id('sala'), 'scene', null, null, '2.2.2.2|firefox', :'late'),
  'recorded', 'a scene of the published tour counts');
select is(worker_api.record_visit(:'ta', 'destination_tour', 'museo', null, 'qr', null, null, null, :'late'),
  'recorded', 'a QR scan of the tour counts, even without an address (no visitor)');

-- ── What does not ─────────────────────────────────────────────────────────
select is(worker_api.record_visit(:'ta', 'destination', 'oculto', null, 'view', 'BO', null, 'x', :'late'),
  'ignored', 'a place never published does not count');
select is(worker_api.record_visit(:'ta', 'destination', 'feria', null, 'view', 'BO', null, 'x', :'late'),
  'ignored', 'an event slug as a destination does not count');
select is(worker_api.record_visit(:'ta', 'destination_tour', 'museo', gen_random_uuid(), 'scene', null, null, 'x', :'late'),
  'ignored', 'a scene that is not in the published tour does not count');
select is(worker_api.record_visit(:'ta', 'event_tour', 'feria', null, 'view', null, null, 'x', :'late'),
  'ignored', 'the tour page of a place without a tour does not count');
select is(worker_api.record_visit(:'ta', 'home', null, null, 'directions', null, null, 'x', :'late'),
  'ignored', '«Cómo llegar» is not an event of the home page');
select is(worker_api.record_visit(:'ta', 'destination', 'museo', null, 'calendar', null, null, 'x', :'late'),
  'ignored', 'a place has no calendar');
select is(worker_api.record_visit(:'ta', 'privacy', null, null, 'view', null, null, 'x', :'late'),
  'ignored', 'an unknown page does not count');
select is(worker_api.record_visit(:'tp', 'home', null, null, 'view', null, null, 'x', :'late'),
  'ignored', 'a municipality that is not online does not count');
reset role;

-- ── The totals ────────────────────────────────────────────────────────────
select results_eq(
  format($$select day, views, visitors from public.visit_daily_counts
           where tenant_id = %L and target = 'home' and event = 'view'$$, :'ta'),
  $$values ('2026-11-14'::date, 3, 2)$$,
  'the home page: 3 views by 2 visitors, on the municipality''s day (not UTC)');
select results_eq(
  format($$select content_id, scene_id, views, visitors from public.visit_daily_counts
           where tenant_id = %L and target = 'destination_tour' and event = 'scene'$$, :'ta'),
  format($$values (%L::uuid, %L::uuid, 1, 1)$$, pg_temp.id('museo'), pg_temp.id('sala')),
  'the scene, by place and scene');
select results_eq(
  format($$select views, visitors from public.visit_daily_counts
           where tenant_id = %L and target = 'destination_tour' and event = 'qr'$$, :'ta'),
  $$values (1, 0)$$,
  'a scan without an address is a view without a visitor');
select results_eq(
  format($$select country, city, views, visitors from public.visit_daily_origins
           where tenant_id = %L order by country$$, :'ta'),
  $$values ('AR', 'Salta', 1, 1), ('BO', 'Cochabamba', 3, 1)$$,
  'origins count page views only, and a visitor once a day');
select is((select count(*)::int from public.visit_daily_counts where tenant_id = :'tb'), 0,
  'the other municipality''s museum (same address) counted nothing');

-- ── The cap and the forgetting ────────────────────────────────────────────
set local role rikuy_worker;
select is(
  (select count(*)::int from generate_series(1, 500) i
   where worker_api.record_visit(:'tb', 'home', null, null, 'view', null, null, 'flood', :'late') = 'recorded'),
  500, 'a visitor adds up to 500 events a day');
select is(worker_api.record_visit(:'tb', 'home', null, null, 'view', null, null, 'flood', :'late'),
  'capped', 'and nothing past that');
reset role;
select is((select views from public.visit_daily_counts where tenant_id = :'tb' and target = 'home'), 500,
  'the capped event did not count');
select ok((select bool_and(hash ~ '^[0-9a-f]{64}$' and hash !~ 'flood|1\.1\.1\.1') from private.visit_marks),
  'only hashes are kept for the visitors, never the address');
update private.visit_marks set day = day - 400;
update private.visit_salts set day = day - 400;
select private.forget_visit_marks();
select ok(not exists (select 1 from private.visit_marks) and not exists (select 1 from private.visit_salts),
  'marks and salts older than two days are forgotten');

select * from finish();
rollback;
