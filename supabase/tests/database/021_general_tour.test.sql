-- The general tour (P4 · Paso 5): the municipality orders its visible tours and chooses the
-- one the general tour starts with; owners and administrators only, with the edit number;
-- tours of another municipality or never published are refused; visitors read the order.
begin;
set local client_min_messages to warning;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

\set ta 'aaaaaaaa-0000-4000-8000-000000000001'
\set tb 'bbbbbbbb-0000-4000-8000-000000000001'
\set a1c '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}'
\set a2c '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}'
\set a3c '{"sub":"00000000-0000-4000-8000-0000000000a3","role":"authenticated"}'
\set b1c '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}'
\set pano '{"version":1,"projection":"equirectangular","source":{"width":4096,"height":2048,"bytes":9000,"mime":"image/jpeg","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"preview":{"file":"preview.webp","width":1024,"height":512,"bytes":18000},"image":{"file":"image.webp","width":4096,"height":2048,"bytes":1400000},"tiles":null}'
\set place '{"title":"%s","summary":"Un lugar","body":[],"location":{"lat":-17.39,"lng":-66.15},"cover":null,"gallery":[]}'

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

-- One public panorama per tour.
create temp table media (name text primary key, tenant uuid, asset uuid default gen_random_uuid(), version_id uuid default gen_random_uuid());
insert into media (name, tenant) values ('molino', :'ta'), ('museo', :'ta'), ('plaza', :'ta'), ('feria', :'ta'), ('borrador', :'ta'), ('ajeno', :'tb');
insert into public.assets (id, tenant_id, purpose) select asset, tenant, 'panorama' from media;
insert into public.asset_versions (id, tenant_id, asset_id, version, status, declared_mime, declared_bytes, mime, bytes, width, height, sha256, ready_at, published_at, manifest)
select version_id, tenant, asset, 1, 'ready', 'image/jpeg', 1000, 'image/jpeg', 1000, 4096, 2048, repeat('c', 64), now(), now(), :'pano'::jsonb from media;
grant select on media to authenticated, anon;
create temp table ids (name text primary key, id uuid);
grant select, insert on ids to authenticated;
grant select on ids to anon;

-- A published destination with a published one-scene tour.
create function pg_temp.published_tour(p_tenant uuid, p_name text, p_kind public.content_kind, p_document jsonb, p_publish_tour boolean)
returns void language plpgsql as $$
declare v_content uuid; v_tour uuid; v_edit integer;
begin
  select content_id into v_content from public.create_content_item(p_tenant, p_kind, p_name, initcap(p_name));
  perform public.save_content_draft(p_tenant, v_content, p_document, 1);
  perform public.publish_content(p_tenant, v_content, 2);
  select tour_id into v_tour from public.create_tour(p_tenant, v_content);
  select edit_count into v_edit from public.add_tour_scene(p_tenant, v_tour, 1, (select version_id from media where name = p_name), 'Entrada');
  if p_publish_tour then perform public.publish_tour(p_tenant, v_tour, v_edit); end if;
  insert into ids values (p_name, v_tour);
end;
$$;

set local role authenticated;
set local request.jwt.claims to :'a1c';
select pg_temp.published_tour(:'ta', 'museo', 'destination', format(:'place', 'Museo')::jsonb, true);
select pg_temp.published_tour(:'ta', 'plaza', 'destination', format(:'place', 'Plaza')::jsonb, true);
select pg_temp.published_tour(:'ta', 'molino', 'destination', format(:'place', 'Molino')::jsonb, true);
select pg_temp.published_tour(:'ta', 'borrador', 'destination', format(:'place', 'Borrador')::jsonb, false);
select pg_temp.published_tour(:'ta', 'feria', 'event', jsonb_build_object(
  'title', 'Feria', 'summary', 'Ya pasó', 'body', '[]'::jsonb, 'location', '{"lat":-17.39,"lng":-66.15}'::jsonb,
  'cover', null, 'gallery', '[]'::jsonb, 'venueId', null,
  'schedule', jsonb_build_object('allDay', true, 'start', to_char(now() - interval '10 days', 'YYYY-MM-DD'), 'end', to_char(now() - interval '9 days', 'YYYY-MM-DD'))), true);
reset role;
set local role authenticated;
set local request.jwt.claims to :'b1c';
select pg_temp.published_tour(:'tb', 'ajeno', 'destination', format(:'place', 'Ajeno')::jsonb, true);
reset role;

create function pg_temp.order_of(p_tenant uuid) returns text[] language sql as $$
  select array_agg(slug || case when is_start then '*' else '' end order by "position") from public.portal_tour_index(p_tenant)
$$;
grant execute on function pg_temp.order_of(uuid) to anon, authenticated;

select plan(24);

-- ── Before any choice: kind and title, the first one starts ─────────────────
set local role anon;
select is(pg_temp.order_of(:'ta'), array['molino*', 'museo', 'plaza'], 'without a choice: by title, the first tour starts');
select is((select array_agg("position" order by "position") from public.portal_tour_index(:'ta')), array[0, 1, 2], 'positions in order');

-- ── The panel's view ────────────────────────────────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to :'a3c';
create temp table ed0 as select public.general_tour_editor(:'ta') as doc;
select is((select (doc ->> 'editCount')::integer from ed0), 0, 'an analyst reads the general tour; nothing saved yet');
select is((select jsonb_array_length(doc -> 'tours') from ed0), 4, 'every tour with a published version (not the never-published one)');
select is((select t ->> 'visible' from ed0, jsonb_array_elements(doc -> 'tours') t where t ->> 'slug' = 'feria'), 'false',
  'an ended event is listed as not visible');
select is((select t ->> 'ended' from ed0, jsonb_array_elements(doc -> 'tours') t where t ->> 'slug' = 'feria'), 'true', 'because it ended');

-- ── Who can save ────────────────────────────────────────────────────────────
select throws_ok(format('select * from public.save_general_tour(%L, 0, array[%L]::uuid[], null)', :'ta', (select id from ids where name = 'plaza')),
  '42501', null, 'an analyst cannot change the order');
reset role;
set local role authenticated;
set local request.jwt.claims to :'a2c';
select throws_ok(format('select * from public.save_general_tour(%L, 0, array[%L]::uuid[], null)', :'ta', (select id from ids where name = 'plaza')),
  '42501', null, 'nor an editor: the order is public at once, like publishing');
reset role;
set local role authenticated;
set local request.jwt.claims to :'b1c';
select throws_ok(format('select * from public.save_general_tour(%L, 0, array[]::uuid[], null)', :'ta'),
  '42501', null, 'nor the owner of another municipality');

-- ── Saving ──────────────────────────────────────────────────────────────────
reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select is((select edit_count from public.save_general_tour(:'ta', 0,
  array[(select id from ids where name = 'plaza'), (select id from ids where name = 'museo')], (select id from ids where name = 'museo'))),
  1, 'the owner saves an order and a start tour');
set local role anon;
select is(pg_temp.order_of(:'ta'), array['plaza', 'museo*', 'molino'], 'visitors get that order; a tour left out goes after; the chosen one starts');

reset role;
set local role authenticated;
set local request.jwt.claims to :'a1c';
select throws_ok(format('select * from public.save_general_tour(%L, 0, array[]::uuid[], null)', :'ta'),
  'PT409', null, 'an old edit number is refused');
select throws_ok(format('select * from public.save_general_tour(%L, 1, array[%L, %L]::uuid[], null)', :'ta',
  (select id from ids where name = 'plaza'), (select id from ids where name = 'plaza')),
  '22023', null, 'a tour twice is refused');
select throws_ok(format('select * from public.save_general_tour(%L, 1, array[%L, null]::uuid[], null)', :'ta', (select id from ids where name = 'plaza')),
  '22023', null, 'an empty place is refused');
select throws_ok(format('select * from public.save_general_tour(%L, 1, array[%L]::uuid[], null)', :'ta', (select id from ids where name = 'ajeno')),
  '23514', null, 'another municipality''s tour is refused');
select throws_ok(format('select * from public.save_general_tour(%L, 1, array[%L]::uuid[], null)', :'ta', (select id from ids where name = 'borrador')),
  '23514', null, 'a tour never published is refused');
select throws_ok(format('select * from public.save_general_tour(%L, 1, array[]::uuid[], %L)', :'ta', (select id from ids where name = 'ajeno')),
  '23514', null, 'so is another municipality''s tour as the start');

-- A start tour visitors do not see (an ended event): saved, and the first one starts instead.
select is((select edit_count from public.save_general_tour(:'ta', 1,
  array[(select id from ids where name = 'feria'), (select id from ids where name = 'molino')], (select id from ids where name = 'feria'))),
  2, 'an ended event can be placed and chosen');
set local role anon;
select is(pg_temp.order_of(:'ta'), array['molino*', 'museo', 'plaza'], 'it stays out; the first visible tour starts');
reset role;
select is((select diff -> 'start_tour_id' from public.audit_events where action = 'tour.general_saved' and tenant_id = :'ta' and revision = 2),
  to_jsonb((select id from ids where name = 'feria')), 'each change is audited');

-- ── Privacy and isolation ───────────────────────────────────────────────────
set local role anon;
select throws_ok('select count(*) from public.general_tours', '42501', null, 'visitors do not read the tables');
reset role;
set local role authenticated;
set local request.jwt.claims to :'b1c';
select is((select count(*)::integer from public.general_tour_entries where tenant_id = :'ta'), 0, 'another municipality''s order is not visible');
select is(pg_temp.order_of(:'tb'), array['ajeno*'], 'and each municipality has its own');
select ok(not has_function_privilege('anon', 'public.save_general_tour(uuid, integer, uuid[], uuid)', 'execute')
          and not has_function_privilege('anon', 'public.general_tour_editor(uuid)', 'execute')
          and has_function_privilege('anon', 'public.portal_tour_index(uuid)', 'execute'),
  'visitors only read the index');

select * from finish();
rollback;
