-- C1 · Paso 2 (ADR-052): «Estadísticas». Every member of a municipality (owner, admin, editor,
-- analyst) reads its daily totals through two functions only, for a period of at most 400
-- days; owners and admins need their second factor, like everywhere else (ADR-043); another
-- municipality and visitors read nothing. Places and scenes come with their current names.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}'
\set a1_aal1 '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}'
\set a2 '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal1"}'
\set a3 '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated","aal":"aal1"}'
\set b1 '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}'
\set sha '0000000000000000000000000000000000000000000000000000000000000abc'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":8192,"height":4096,"bytes":9000000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'
\set place '{"title":"%s","summary":"Un lugar","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a2', 'analyst.a@example.test'),
  ('00000000-0000-4000-8000-0000000000a3', 'editor.a@example.test'),
  ('00000000-0000-4000-8000-0000000000b1', 'owner.b@example.test');
insert into public.tenants (id, slug, display_name, status, default_locale, timezone) values
  (:'ta', 'tenant-a', 'Tenant A', 'provisioning', 'es', 'America/La_Paz'),
  (:'tb', 'tenant-b', 'Tenant B', 'provisioning', 'es', 'Europe/Madrid');
insert into public.memberships (tenant_id, user_id, role, status, accepted_at) values
  (:'ta', '00000000-0000-4000-8000-0000000000a1', 'owner', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a2', 'analyst', 'active', now()),
  (:'ta', '00000000-0000-4000-8000-0000000000a3', 'editor', 'active', now()),
  (:'tb', '00000000-0000-4000-8000-0000000000b1', 'owner', 'active', now());
update public.tenants set status = 'active' where id in (:'ta', :'tb');
set constraints all immediate;

create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from ids where name = p_name $$;
create temp table media (tenant uuid, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (tenant) values (:'ta');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, 'panorama' from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, manifest, published_at)
select version_id, tenant, asset, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 8192, 4096, :'sha', now(), :'pano'::jsonb, now()
from media;
grant select on media to authenticated;

-- A: «Museo» published, then renamed in a draft (the published name is the one shown); «Nuevo»
-- never published (its draft name); a tour of the museum with «Sala», renamed in its draft.
set local role authenticated;
set local request.jwt.claims to :'a1';
insert into ids select 'museo', content_id from public.create_content_item(:'ta', 'destination', 'museo', 'Museo');
insert into ids select 'nuevo', content_id from public.create_content_item(:'ta', 'destination', 'nuevo', 'Nuevo');
select * from public.save_content_draft(:'ta', pg_temp.id('museo'), format(:'place', 'Museo')::jsonb, 1);
select * from public.publish_content(:'ta', pg_temp.id('museo'), 2);
select * from public.save_content_draft(:'ta', pg_temp.id('museo'), format(:'place', 'Museo renombrado')::jsonb, null);
insert into ids select 'T', tour_id from public.create_tour(:'ta', pg_temp.id('museo'));
insert into ids select 'sala', scene_id from public.add_tour_scene(:'ta', pg_temp.id('T'), 1, (select version_id from media), 'Sala');
select * from public.publish_tour(:'ta', pg_temp.id('T'), 2);
select * from public.update_tour_scene(:'ta', pg_temp.id('T'), null, pg_temp.id('sala'), '{"title":"Sala nueva"}');
set local request.jwt.claims to :'b1';
insert into ids select 'museo_b', content_id from public.create_content_item(:'tb', 'destination', 'museo', 'Museo B');
reset role;

-- The totals (written by the worker in production; here, directly).
insert into public.visit_daily_counts (tenant_id, day, target, content_id, scene_id, event, views, visitors) values
  (:'ta', '2026-10-31', 'home', null, null, 'view', 50, 40),
  (:'ta', '2026-11-01', 'home', null, null, 'view', 10, 7),
  (:'ta', '2026-11-02', 'home', null, null, 'view', 5, 4),
  (:'ta', '2026-11-01', 'destination', pg_temp.id('museo'), null, 'view', 6, 5),
  (:'ta', '2026-11-02', 'destination', pg_temp.id('museo'), null, 'view', 4, 3),
  (:'ta', '2026-11-02', 'destination', pg_temp.id('museo'), null, 'qr', 2, 2),
  (:'ta', '2026-11-02', 'destination', pg_temp.id('museo'), null, 'directions', 3, 2),
  (:'ta', '2026-11-02', 'destination', pg_temp.id('nuevo'), null, 'view', 1, 1),
  (:'ta', '2026-11-02', 'destination_tour', pg_temp.id('museo'), pg_temp.id('sala'), 'scene', 9, 3),
  (:'tb', '2026-11-02', 'destination', pg_temp.id('museo_b'), null, 'view', 99, 99);
insert into public.visit_daily_origins (tenant_id, day, country, city, views, visitors) values
  (:'ta', '2026-11-01', 'BO', 'Cliza', 12, 8),
  (:'ta', '2026-11-02', 'BO', 'Cliza', 6, 4),
  (:'ta', '2026-11-02', 'AR', 'Salta', 4, 2),
  (:'ta', '2026-11-02', null, null, 1, 1),
  (:'tb', '2026-11-02', 'ES', 'Madrid', 99, 99);

create temp table result (name text primary key, value jsonb);
grant select, insert on result to authenticated;

select plan(25);

-- ── Who reads ─────────────────────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'public.tenant_visit_statistics(uuid, date, date, boolean)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.tenant_visit_calendar(uuid)', 'EXECUTE'),
  'visitors cannot read the statistics');
select ok(not has_table_privilege('authenticated', 'public.visit_daily_counts', 'SELECT')
          and not has_table_privilege('authenticated', 'public.visit_daily_origins', 'SELECT'),
  'members still cannot read the tables directly');

set local role authenticated;
set local request.jwt.claims to :'a1';
select results_eq(
  format($$select timezone, first_day from public.tenant_visit_calendar(%L)$$, :'ta'),
  $$values ('America/La_Paz'::text, '2026-10-31'::date)$$,
  'the owner gets the municipality''s clock and its first counted day');
insert into result select 'owner', public.tenant_visit_statistics(:'ta', '2026-11-01', '2026-11-02');
insert into result select 'daily', public.tenant_visit_statistics(:'ta', '2026-11-01', '2026-11-02', true);
insert into result select 'empty', public.tenant_visit_statistics(:'ta', '2025-01-01', '2025-01-31');

set local request.jwt.claims to :'a2';
select lives_ok(format($$select public.tenant_visit_statistics(%L, '2026-11-01', '2026-11-02')$$, :'ta'),
  'an analyst reads them');
select lives_ok(format($$select * from public.tenant_visit_calendar(%L)$$, :'ta'),
  'an analyst reads the calendar');
set local request.jwt.claims to :'a3';
select lives_ok(format($$select public.tenant_visit_statistics(%L, '2026-11-01', '2026-11-02')$$, :'ta'),
  'an editor reads them');

set local request.jwt.claims to :'a1_aal1';
select throws_ok(format($$select public.tenant_visit_statistics(%L, '2026-11-01', '2026-11-02')$$, :'ta'),
  '42501', null, 'an owner without the second factor does not (ADR-043)');
set local request.jwt.claims to :'b1';
select throws_ok(format($$select public.tenant_visit_statistics(%L, '2026-11-01', '2026-11-02')$$, :'ta'),
  '42501', null, 'another municipality''s owner does not');
select throws_ok(format($$select * from public.tenant_visit_calendar(%L)$$, :'ta'),
  '42501', null, 'nor its calendar');

-- ── The period ────────────────────────────────────────────────────────────
set local request.jwt.claims to :'a1';
select throws_ok(format($$select public.tenant_visit_statistics(%L, '2026-11-02', '2026-11-01')$$, :'ta'),
  '22023', null, 'a period that ends before it starts is refused');
select throws_ok(format($$select public.tenant_visit_statistics(%L, '2025-01-01', '2026-11-01')$$, :'ta'),
  '22023', null, 'a period longer than 400 days is refused');
select throws_ok(format($$select public.tenant_visit_statistics(%L, null, '2026-11-01')$$, :'ta'),
  '22023', null, 'a period without a start is refused');
reset role;

-- ── What they add up ──────────────────────────────────────────────────────
select results_eq(
  $$select (i ->> 'views')::int, (i ->> 'visitors')::int, i ->> 'title', i ->> 'kind', i ->> 'slug'
    from result, jsonb_array_elements(value -> 'items') i
    where name = 'owner' and i ->> 'target' = 'destination' and i ->> 'event' = 'view'
      and i ->> 'slug' = 'museo'$$,
  $$values (10, 8, 'Museo'::text, 'destination'::text, 'museo'::text)$$,
  'a place adds up its days, named by its published version (not the draft)');
select results_eq(
  $$select i ->> 'title' from result, jsonb_array_elements(value -> 'items') i
    where name = 'owner' and i ->> 'slug' = 'nuevo'$$,
  $$values ('Nuevo'::text)$$,
  'a place that was never published is named by its draft');
select results_eq(
  $$select (i ->> 'views')::int, i ->> 'sceneTitle' from result, jsonb_array_elements(value -> 'items') i
    where name = 'owner' and i ->> 'event' = 'scene'$$,
  $$values (9, 'Sala'::text)$$,
  'a scene is named by the published version of its tour');
select results_eq(
  $$select (i ->> 'views')::int from result, jsonb_array_elements(value -> 'items') i
    where name = 'owner' and i ->> 'target' = 'home'$$,
  $$values (15)$$,
  'days outside the period are left out');
select is(
  (select count(*)::int from result, jsonb_array_elements(value -> 'items') i
   where name = 'owner' and i ->> 'day' is not null),
  0, 'without p_daily, the items are totals of the whole period');
select results_eq(
  $$select i ->> 'day', (i ->> 'views')::int from result, jsonb_array_elements(value -> 'items') i
    where name = 'daily' and i ->> 'target' = 'destination' and i ->> 'event' = 'view'
      and i ->> 'slug' = 'museo' order by 1$$,
  $$values ('2026-11-01'::text, 6), ('2026-11-02'::text, 4)$$,
  'with p_daily, one row per day');
select results_eq(
  $$select d ->> 'day', (d ->> 'views')::int, (d ->> 'visitors')::int
    from result, jsonb_array_elements(value -> 'days') d where name = 'owner' order by 1$$,
  $$values ('2026-11-01'::text, 16, 8), ('2026-11-02'::text, 10, 7)$$,
  'per day: page views (not scenes nor actions) and the distinct visitors of the portal');
select results_eq(
  $$select o ->> 'country', o ->> 'city', (o ->> 'views')::int, (o ->> 'visitors')::int
    from result, jsonb_array_elements(value -> 'origins') o where name = 'owner'$$,
  $$values ('BO'::text, 'Cliza'::text, 18, 12), ('AR', 'Salta', 4, 2), (null, null, 1, 1)$$,
  'origins add up by country and city, unknown ones included');
select is(
  (select count(*)::int from result, jsonb_array_elements(value -> 'items') i
   where name = 'owner' and (i ->> 'views')::int = 99),
  0, 'another municipality''s counts never appear');
select is(
  (select count(*)::int from result, jsonb_array_elements(value -> 'origins') o
   where name = 'owner' and o ->> 'country' = 'ES'),
  0, 'nor its origins');
select is(
  (select value from result where name = 'empty'),
  '{"from":"2025-01-01","to":"2025-01-31","items":[],"days":[],"origins":[]}'::jsonb,
  'a period without counts is empty, not an error');

-- A deleted tour leaves its scenes without a name (the counts stay with the place).
set local role authenticated;
set local request.jwt.claims to :'a1';
select * from public.delete_tour(:'ta', pg_temp.id('T'));
select results_eq(
  format($$select (i ->> 'views')::int, i ->> 'sceneTitle'
           from jsonb_array_elements(public.tenant_visit_statistics(%L, '2026-11-01', '2026-11-02') -> 'items') i
           where i ->> 'event' = 'scene'$$, :'ta'),
  $$values (9, null::text)$$,
  'a deleted tour keeps its scene counts, without a name');
reset role;
select is(
  (select count(*)::int from public.visit_daily_counts where tenant_id = :'ta'),
  9, 'reading changes nothing');

select * from finish();
rollback;
